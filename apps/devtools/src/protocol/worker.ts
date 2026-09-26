export {};
import { AppCommandError, defineAppCommand } from '@bundled/yaar';
import {
  activeProject,
  bundleStatus,
  compileErrors,
  diagnostics,
  files,
  typecheckState,
  setTypecheckState,
} from '../core';
import { applyEdits, type EditSpec } from '../lib/edits';
import { classifyChange, filesNamedInTask, splitBySize } from '../lib/source-scan';
import { resolveCompileStatus } from '../lib/compile-status';
import {
  compile,
  grep,
  readFileContent,
  readFileText,
  typecheck,
  writeFile,
  addWorkerEditRequest,
  addWorkerReport,
  findProposal,
  interruptWorker,
  noteWorkerToolCall,
  queueWorkerFeedback,
  resolveProposal,
  startWorkerTask,
  validateProposedEdits,
  waitForWorker,
  workerProposals,
  workerCap,
  setWorkerCap,
  workerSlots,
  pendingOnPath,
  parseEditSpecs,
  noteWorkerRead,
  noteWorkerGrep,
  freeWorkerCount,
  MAX_WORKERS,
  NO_ACTIVE_PROJECT,
  type EditProposal,
} from '../services';

// Two audiences, one file. `workerTask`/`workerWait`/`workerInterrupt` and the
// three `*EditRequest` commands are the app agent's door — the ones that appear
// in the manifest, so the concierge can delegate survey work instead of spending
// its own turns on reads, collect it when it has run out of work to do
// meanwhile, and take or decline the edits that came back.
//
// `acceptEditRequest` is the only writer among them, and it is deliberately the
// most guarded command in this app: it wants a token that only `readEditRequest`
// hands out and a sentence the caller wrote itself, because the whole reason to
// let a sonnet-tier explorer author edits is that a slower agent read them first. The `persona:*` entries are
// the handler halves of the tools the worker sub-agent is spawned with
// (services/worker.ts declares the other halves — the names and the descriptions
// the worker reads); their prefix hides them from the app agent's manifest, so
// the concierge never reads a script meant for the worker.
//
// `personaId` is stamped by the server rather than written by the model. The
// three lookup tools are read-only against the active project, which is exactly
// the reach the worker is promised: it sees what devtools shows it, and nothing
// else. `report` is the one that goes the other way — the worker talking back
// mid-turn — and it is a tool like any other here rather than a new capability,
// which is what keeps its audience to this iframe and the one agent behind it.
//
// Each handler reports through `noteWorkerToolCall` (`report` through
// `addWorkerReport`) — that is both the line in the panel transcript and the
// watchdog's sign of life for a turn that is calling tools instead of emitting
// text frames.

/** Shared with the dry run in services/worker.ts, which refuses the same way. */
const NO_PROJECT = NO_ACTIVE_PROJECT;

/** Named files past this size are refused as one task; ~280 KB was seen to go quiet. */
const TASK_BYTES_LIMIT = 150_000;
const TASK_CHUNK_BYTES = 120_000;

/**
 * Apply an accepted proposal and hand back what changed, or throw.
 *
 * Applied here rather than through the `editFile` service so the write carries
 * the proposal's number into the change history: the Changes panel is the only
 * place a human sees that an edit came from the worker rather than from the
 * agent they were talking to.
 */
interface Applied {
  proposal: EditProposal;
  edits: EditSpec[];
  lines: number;
  before: string;
  after: string;
}

async function applyProposal(
  id: number,
  path: string,
  edits: EditSpec[],
): Promise<{ before: string; after: string }> {
  const before = await readFileText(path);
  if (before === null) throw new AppCommandError('No such file in the active project: ' + path);
  const { content: after } = applyEdits(before, edits, { requireUnique: true });
  await writeFile(path, after, { before, label: 'worker edit #' + id });
  return { before, after };
}

/**
 * Accepts run one at a time. Each one writes, typechecks, compiles and may roll
 * back; two interleaved would judge each other's build and could revert a file
 * the other had just written.
 */
let acceptChain: Promise<unknown> = Promise.resolve();
function serializeAccept<T>(run: () => Promise<T>): Promise<T> {
  const next = acceptChain.then(run, run);
  acceptChain = next.catch(() => {});
  return next;
}

/** Type errors right now, and whether that number means anything yet. */
function typeErrorCount(): { count: number; reliable: boolean } {
  return {
    count: diagnostics().filter((d) => d.severity === 'error').length,
    reliable: typecheckState() !== 'unknown',
  };
}

export const workerCommands = {
  workerConfig: defineAppCommand({
    description:
      'Read or set how many workers may run tasks at the same time (1-3, default 2), persisted across reloads. Returns { maxWorkers, workers } with each ' +
      "worker's status and running taskId. Lowering the cap stops nothing already running; " +
      'it only refuses new tasks beyond it. Workers are read-only, so parallel ones never ' +
      'clobber files — their proposed edits are applied one at a time by acceptEditRequest.',
    params: {
      type: 'object',
      properties: {
        maxWorkers: {
          type: 'number',
          description: 'New cap, 1-3. Omit to read the current settings.',
        },
      },
    },
    replay: 'never',
    run: async (p) => {
      if (p.maxWorkers != null) {
        const n = Number(p.maxWorkers);
        if (!Number.isFinite(n)) throw new AppCommandError('maxWorkers must be a number.');
        await setWorkerCap(n);
      }
      const cap = workerCap();
      return {
        maxWorkers: cap,
        ceiling: MAX_WORKERS,
        workers: workerSlots.map((s, i) => ({
          worker: s.id,
          status: s.status(),
          enabled: i < cap,
          taskId: s.activeTask()?.id ?? null,
        })),
      };
    },
  }),
  workerTask: defineAppCommand({
    description:
      'Start one task on the worker — a sonnet-tier sub-agent that explores the active ' +
      'project with its own read-only tools (list files, read file, grep) and reports back; ' +
      'it cannot edit, compile, or deploy. For a task that needs a change it submits the exact ' +
      'edit instead of describing it, which arrives as `proposals` — summaries of edits already ' +
      'verified to apply cleanly, taken with acceptEditRequest and turned down with ' +
      'rejectEditRequest, so a delegated fix costs you a read and a decision rather than ' +
      'retyping it. RETURNS IMMEDIATELY with a taskId. You are then ' +
      'WOKEN with the answer when it lands (an <app:event channel="worker"> message with ' +
      'kind "result") — workerWait blocks for it instead, and the "worker" state key is the ' +
      'plain look. Interim findings arrive with the result; an urgent one wakes you early ' +
      'as kind "report" — a cue to re-scope or call workerInterrupt, not a sign the task is ' +
      'done. A very long answer can reach you with its long fields shortened — each ending ' +
      '"…[cut, N chars]", with a note after the JSON naming them — because the wakeup is a ' +
      'prompt injection with a context budget; call workerWait with the taskId to read the ' +
      'full record, which is kept whole. Several workers run in parallel, up to the cap in ' +
      '`workerConfig` (default 2, max 3): each call lands on a free worker and returns its ' +
      '`worker` id, so fan independent surveys out as separate tasks and collect each by ' +
      'taskId. A worker keeps its memory across tasks and a task goes to the worker that ' +
      'finished last when it is free — pass `worker` to pin a follow-up to a specific one, ' +
      'and `fresh` to opt out of memory. With every worker busy the call is refused, not queued. ' +
      'Files the task names (paths, directories, globs) are its scope: a task naming more than ' +
      '~150 KB of them is refused with a suggested split, since one worker turn that size ' +
      'tends to end with "went quiet" — pass `split: true` to run it as parallel chunks, or ' +
      '`allowLarge: true` to run it whole. The result reports `filesRead` and `filesNotRead` ' +
      'against that scope, and a turn that went quiet carries a `stopDiagnosis`.',
    params: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'The task, self-contained — the worker sees none of your context.',
        },
        worker: {
          type: 'string',
          description:
            'Run on this worker ("worker", "worker-2", "worker-3") — for a follow-up that ' +
            "needs that worker's memory. Refused if it is busy or beyond the cap. Omit to use " +
            'any free one.',
        },
        fresh: {
          type: 'boolean',
          description:
            'Retire the chosen worker first, so this task starts with no memory of earlier ones. ' +
            'Use when its context has gone stale or an earlier answer was wrong and you do ' +
            'not want this one built on it. Costs a respawn; the default (false) is right ' +
            'for a follow-up.',
        },
        split: {
          type: 'boolean',
          description:
            'When the named files exceed the size limit, start one task per ~120 KB chunk on ' +
            'free workers, each told to read only its chunk. Refused if there are more chunks ' +
            'than free workers. Returns `tasks`, one per chunk.',
        },
        allowLarge: {
          type: 'boolean',
          description: 'Run an over-limit task on one worker anyway.',
        },
      },
      required: ['task'],
    },
    replay: 'never',
    run: async (p) => {
      const task = String(p.task ?? '');
      const scope = filesNamedInTask(task, files());
      const scopeBytes = scope.reduce((n, f) => n + f.bytes, 0);
      const kb = (bytes: number) => Math.round(bytes / 1000);
      if (scopeBytes > TASK_BYTES_LIMIT && p.allowLarge !== true) {
        const chunks = splitBySize(scope, TASK_CHUNK_BYTES);
        const describe = (chunk: typeof scope) =>
          `${chunk.length} files, ~${kb(chunk.reduce((n, f) => n + f.bytes, 0))} KB: ` +
          chunk.map((f) => f.path).join(', ');
        if (p.split !== true) {
          throw new AppCommandError(
            `This task names ${scope.length} files, ~${kb(scopeBytes)} KB — past the ` +
              `~${kb(TASK_BYTES_LIMIT)} KB one worker reliably finishes in a turn. Pass split: true ` +
              `to run it as ${chunks.length} parallel tasks, narrow the task, or pass ` +
              'allowLarge: true to run it whole. Suggested split:\n' +
              chunks.map((c, i) => `${i + 1}. ${describe(c)}`).join('\n'),
          );
        }
        if (p.worker != null || p.fresh === true) {
          throw new AppCommandError('split picks its own workers — drop `worker` and `fresh`.');
        }
        const free = freeWorkerCount();
        if (chunks.length > free) {
          throw new AppCommandError(
            `split needs ${chunks.length} free workers and ${free} ${free === 1 ? 'is' : 'are'} free ` +
              `(cap ${workerCap()}). Raise the cap with workerConfig, wait for a running task, ` +
              'or narrow the task.',
          );
        }
        const tasks = [];
        for (const chunk of chunks) {
          const started = await startWorkerTask(
            `${task}\n\nYour share of this task is only these files; other workers cover the ` +
              `rest, so do not read beyond them: ${chunk.map((f) => f.path).join(', ')}`,
            { wakeAgent: true, scope: chunk.map((f) => f.path) },
          );
          if (started.error) throw new AppCommandError(started.error);
          tasks.push({
            taskId: started.taskId,
            worker: started.worker,
            files: chunk.length,
            kb: kb(chunk.reduce((n, f) => n + f.bytes, 0)),
          });
        }
        return {
          split: true,
          tasks,
          collect: 'You will be woken once per task. workerWait with each taskId collects them.',
        };
      }
      // `wakeAgent` is what separates this call from the same task typed into the
      // Worker panel: the agent asked, so the agent is woken when it settles.
      const started = await startWorkerTask(task, {
        wakeAgent: true,
        ...(p.fresh === true ? { fresh: true } : {}),
        ...(p.worker != null ? { worker: String(p.worker) } : {}),
      });
      if (started.error) throw new AppCommandError(started.error);
      return {
        taskId: started.taskId,
        worker: started.worker,
        status: 'running',
        ...(scope.length ? { scope: { files: scope.length, kb: kb(scopeBytes) } } : {}),
        collect:
          `You will be woken with the answer (channel "worker", taskId ${started.taskId}). ` +
          'To block for it instead, call workerWait.',
      };
    },
  }),
  workerInterrupt: defineAppCommand({
    description:
      'Stop a running worker task and take whatever it has produced so far — its ' +
      'partial answer and every interim report. Use it when a report or a state-key read ' +
      'shows the task was mis-scoped: a wrong path list, a pattern that matches nothing, an ' +
      'instruction resting on something untrue. Stopping and re-sending a corrected task ' +
      'beats waiting out a turn you already know is wrong. The worker keeps its memory, so ' +
      'the retry can say "same as before, but under src/ this time" (pass the same `worker`). ' +
      'Pass taskId when several tasks run; omitted with more than one running, nothing is ' +
      'stopped and `running` lists the ids.',
    params: {
      type: 'object',
      properties: {
        taskId: {
          type: 'number',
          description: 'The task to stop. Optional when exactly one task is running.',
        },
      },
    },
    replay: 'never',
    run: async (p) => interruptWorker(p.taskId != null ? { taskId: Number(p.taskId) } : {}),
  }),
  workerWait: defineAppCommand({
    description:
      'Collect a task started by workerTask: returns its answer, or `done: false` if it is ' +
      'still working. Blocks up to waitMs (default 60000, max 170000) — always pass a ' +
      'timeoutMs at least 10s larger than waitMs, or the platform kills the call before the ' +
      'wait ends. Timing out is cheap: the task keeps running and calling again resumes the ' +
      'wait, so a long survey can be collected in slices. Omit taskId to collect whichever ' +
      'running task settles first (the result names its taskId and worker; a timeout lists ' +
      'the ids still `running`), or the last one to finish when none runs — so a fan-out of ' +
      'N tasks is N calls. Never re-send a task to "retry" a wait. ' +
      '`reports` carries the interim findings the worker posted, and `proposals` the edits it ' +
      'submitted; both come back on a timeout too — read them before deciding whether to keep ' +
      'waiting or to workerInterrupt. A ' +
      'settled task ALWAYS carries an `answer` or an `error`: an `error` saying the worker ' +
      'produced no answer means nothing was learned, never "nothing was found".',
    params: {
      type: 'object',
      properties: {
        taskId: {
          type: 'number',
          description: 'The id workerTask returned. Omit for the current or most recent task.',
        },
        waitMs: {
          type: 'number',
          description: 'How long to block before reporting back. Default 60000, max 170000.',
        },
      },
    },
    replay: 'never',
    run: async (p) => {
      const result = await waitForWorker({
        ...(p.taskId != null ? { taskId: Number(p.taskId) } : {}),
        ...(p.waitMs != null ? { waitMs: Number(p.waitMs) } : {}),
      });
      // Reported, not thrown, even for `error`: a partial answer, a still-running
      // task and a failure are all things the caller acts on differently, and an
      // AppCommandError flattens the three into one refusal.
      return result;
    },
  }),
  readEditRequest: defineAppCommand({
    description:
      'Read edits the worker proposed, whole: the file, the rationale, the exact ' +
      'search/replace steps, and `evidence` — the greps the worker ran in that task before ' +
      'proposing, with sample matches. The `worker` state key and a task result list ' +
      'proposals as summaries; this is where the bodies are. It also returns the `token` ' +
      'that acceptEditRequest requires, which is the point of the command — an edit cannot be ' +
      'applied without having been read. Pass an array of ids to read several at once. ' +
      'Reading costs nothing and does not commit you.',
    params: {
      type: 'object',
      properties: {
        id: {
          oneOf: [{ type: 'number' }, { type: 'array', items: { type: 'number' } }],
          description: 'A proposal id, or an array of them, as the summaries report it.',
        },
      },
      required: ['id'],
    },
    replay: 'never',
    run: async (p) => {
      const many = Array.isArray(p.id);
      const ids = (many ? (p.id as unknown[]) : [p.id]).map(Number);
      const bodies = ids.map((id) => {
        const proposal = findProposal(id);
        if (!proposal) {
          throw new AppCommandError(
            'No edit request #' +
              id +
              '. Read the `worker` state key for the ones that exist; resetting the worker ' +
              'clears them along with its transcript.',
          );
        }
        const conflicts =
          proposal.status === 'pending' ? pendingOnPath(proposal.path, id).map((q) => q.id) : [];
        return {
          id: proposal.id,
          taskId: proposal.taskId,
          worker: proposal.worker,
          path: proposal.path,
          status: proposal.status,
          ...(conflicts.length ? { conflictsWith: conflicts } : {}),
          rationale: proposal.rationale,
          edits: proposal.edits,
          ...(proposal.evidence?.length ? { evidence: proposal.evidence } : {}),
          token: proposal.token,
          ...(proposal.resolution ? { resolution: proposal.resolution } : {}),
        };
      });
      return many ? { requests: bodies } : bodies[0];
    },
  }),
  acceptEditRequest: defineAppCommand({
    description:
      'Apply edits the worker proposed, then type check and compile once. Requires the ' +
      '`token` from readEditRequest for each id and a one-line `intent` in your own words, ' +
      'because an accept is a judgement and not a forward. Pass arrays for `id` and `token` ' +
      '(same order) to take several proposals with ONE build; a batch skips any that no ' +
      'longer apply and names them in `stale`. When every applied change touches only ' +
      'comments (TS/JS/CSS) or Markdown outside src/, no build runs and `build` says ' +
      '"skipped"; the type-check verdict is kept, since the code it describes is unchanged. ' +
      'Pass `edits` with a single id to accept a corrected version of that proposal: they ' +
      'replace its steps, are dry-run the same way, and the worker is told what you changed. ' +
      'Each proposal is re-checked against the file first and refused without writing if it ' +
      'no longer applies. If the bundle then fails, or type errors increase, every file ' +
      'written is restored, the project is rebuilt clean, and the result carries ' +
      '`rolledBack: true` and the `failure` — a broken build never survives this command. ' +
      '`otherPendingOnPath` names proposals to the same files that were verified against the ' +
      'bytes just replaced. Slow when it builds (up to two builds): pass timeoutMs, e.g. 120000.',
    params: {
      type: 'object',
      properties: {
        id: {
          oneOf: [{ type: 'number' }, { type: 'array', items: { type: 'number' } }],
          description: 'The proposal id, or an array of ids applied in that order.',
        },
        token: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description: 'The token readEditRequest returned; an array matching `id` for a batch.',
        },
        intent: {
          type: 'string',
          description:
            'One line, yours: what these edits do and why you are taking them. Recorded with ' +
            'each proposal and sent back to the worker.',
        },
        edits: {
          type: 'array',
          items: { type: 'object' },
          description:
            'Single id only: your corrected steps, replacing the proposal’s — the same shape ' +
            'as editFile’s `edits` (search/replace, or startLine/endLine/anchor/replace). Each ' +
            'search must match exactly once.',
        },
      },
      required: ['id', 'token', 'intent'],
    },
    replay: 'never',
    run: (p) =>
      serializeAccept(async () => {
        if (!activeProject())
          throw new AppCommandError('No active project. Open or create one first.');
        const many = Array.isArray(p.id);
        const ids = (many ? (p.id as unknown[]) : [p.id]).map(Number);
        const tokens = (Array.isArray(p.token) ? (p.token as unknown[]) : [p.token]).map((t) =>
          String(t ?? ''),
        );
        const intent = String(p.intent ?? '').trim();
        if (ids.length === 0)
          throw new AppCommandError('id is empty — name at least one proposal.');
        if (tokens.length !== ids.length) {
          throw new AppCommandError(
            `Pass one token per id, in the same order: got ${ids.length} ids and ${tokens.length} tokens.`,
          );
        }
        if (new Set(ids).size !== ids.length) {
          throw new AppCommandError('The same id appears twice in `id`.');
        }
        if (intent.length < 12) {
          throw new AppCommandError(
            'intent must say something. One line in your own words about what these edits do ' +
              'and why you are taking them.',
          );
        }
        let amended: EditSpec[] | null = null;
        if (p.edits !== undefined) {
          if (ids.length !== 1) {
            throw new AppCommandError('`edits` amends one proposal — pass a single id with it.');
          }
          amended = parseEditSpecs(p.edits);
          if (!amended || amended.length === 0) {
            throw new AppCommandError(
              '`edits` must be a non-empty array of {search, replace} or ' +
                '{startLine, endLine, anchor, replace} objects.',
            );
          }
        }

        // Every gate before any write: a batch that failed its third token after writing
        // two files would leave a half-taken batch nobody asked for.
        const proposals = ids.map((id, i) => {
          const proposal = findProposal(id);
          if (!proposal) throw new AppCommandError('No edit request #' + id + '.');
          if (proposal.status !== 'pending') {
            throw new AppCommandError(
              'Edit request #' +
                id +
                ' is already ' +
                proposal.status +
                ': ' +
                (proposal.resolution ?? ''),
            );
          }
          if (tokens[i] !== proposal.token) {
            throw new AppCommandError(
              'Wrong token for edit request #' +
                id +
                '. Call readEditRequest first and pass the ' +
                'token it returns — this command will not apply an edit you have not read.',
            );
          }
          return proposal;
        });

        const verdictBefore = typecheckState();
        const baseline = typeErrorCount();
        const applied: Applied[] = [];
        const stale: { id: number; error: string }[] = [];
        for (const proposal of proposals) {
          const id = proposal.id;
          const edits = amended ?? proposal.edits;
          // The proposal was checked when it was submitted, against the file as it was
          // then. Anything since — another accept, an editFile of your own, a project
          // switch — may have invalidated it.
          const recheck = await validateProposedEdits(proposal.path, edits);
          if (!recheck.ok) {
            // An amendment that does not apply is the caller's slip, not the worker's.
            if (!amended) {
              resolveProposal(id, 'failed', 'Stale at accept: ' + recheck.error);
              queueWorkerFeedback(
                'Edit request #' +
                  id +
                  ' could not be applied — ' +
                  recheck.error +
                  ' The file changed after you proposed it. Re-read it before proposing again.',
                proposal.worker,
              );
            }
            if (!many) {
              throw new AppCommandError(
                (amended
                  ? 'Your edits for #' + id + ' do not apply: '
                  : 'Edit request #' + id + ' no longer applies: ') +
                  recheck.error +
                  ' Nothing was written.',
              );
            }
            stale.push({ id, error: recheck.error ?? 'does not apply' });
            continue;
          }
          const written = await applyProposal(id, proposal.path, edits);
          applied.push({ proposal, edits, lines: recheck.lines ?? 0, ...written });
        }

        if (applied.length === 0) {
          return {
            applied: [],
            stale,
            note: 'Nothing was written: no proposal in the batch still applies.',
          };
        }

        const needsBuild = applied.some(
          (a) => classifyChange(a.proposal.path, a.before, a.after) === 'code',
        );
        if (needsBuild) {
          await typecheck();
          await compile();
          const built = bundleStatus() === 'success';
          const after = typeErrorCount();
          // Two different failures, and only one of them is the edits' fault. A bundle
          // that stopped building is. A type error count is only evidence if a
          // typecheck had run before the edit — otherwise the errors may be older than
          // the proposal, and rolling back on them would discard a good edit.
          const regressed = baseline.reliable && after.count > baseline.count;
          if (!built || regressed) {
            const why = !built
              ? 'the bundle failed'
              : 'type errors went from ' + baseline.count + ' to ' + after.count;
            // Read before the revert: the rebuild below succeeds, so asking afterwards
            // reports the clean state and says nothing about what went wrong.
            const failure = built
              ? diagnostics().filter((d) => d.severity === 'error')
              : compileErrors();
            for (const a of [...applied].reverse()) {
              await writeFile(a.proposal.path, a.before, {
                before: a.after,
                label: 'revert worker edit #' + a.proposal.id,
              });
            }
            await typecheck();
            await compile();
            // A batch cannot say which of its edits broke the build, so its proposals
            // stay pending for one-at-a-time accepts instead of being marked failed.
            if (!many) {
              const id = applied[0].proposal.id;
              resolveProposal(id, 'failed', 'Applied and rolled back: ' + why);
              queueWorkerFeedback(
                'Edit request #' +
                  id +
                  ' was applied and rolled back because ' +
                  why +
                  '. ' +
                  (failure.length ? 'First error: ' + JSON.stringify(failure[0]) + '. ' : '') +
                  'Read the file again and check what your replacement text broke.',
                applied[0].proposal.worker,
              );
            }
            return {
              applied: false,
              rolledBack: true,
              ids: applied.map((a) => a.proposal.id),
              reason: why,
              failure,
              ...(many
                ? {
                    note:
                      'Every file in the batch was restored and the proposals are still pending. ' +
                      'Accept them one at a time to find the one that breaks the build.',
                  }
                : {}),
              ...(stale.length ? { stale } : {}),
            };
          }
        } else {
          // Comments and docs only: the verdict from before still describes the code.
          setTypecheckState(verdictBefore);
        }

        for (const a of applied) {
          const id = a.proposal.id;
          resolveProposal(id, 'accepted', amended ? 'Accepted with changes: ' + intent : intent);
          queueWorkerFeedback(
            amended
              ? 'Edit request #' +
                  id +
                  ' was accepted after the caller corrected it. Applied instead of your steps: ' +
                  JSON.stringify(amended).slice(0, 800) +
                  '. ' +
                  intent
              : 'Edit request #' + id + ' was accepted and applied. ' + intent,
            a.proposal.worker,
          );
        }
        const typeErrors = typeErrorCount().count;
        const build = needsBuild ? 'ran' : 'skipped (comments/docs only)';
        const status = resolveCompileStatus(bundleStatus(), typecheckState());
        // Proposals parked against the same files were verified against the bytes these
        // accepts just replaced; name them so the caller re-reads before taking another.
        const doneIds = new Set(applied.map((a) => a.proposal.id));
        const stillPending = [
          ...new Set(
            applied.flatMap((a) =>
              pendingOnPath(a.proposal.path)
                .map((q) => q.id)
                .filter((q) => !doneIds.has(q)),
            ),
          ),
        ];
        if (!many) {
          const a = applied[0];
          return {
            applied: true,
            id: a.proposal.id,
            path: a.proposal.path,
            editsApplied: a.edits.length,
            lines: a.lines,
            ...(amended ? { amended: true } : {}),
            build,
            typeErrors,
            status,
            ...(stillPending.length ? { otherPendingOnPath: stillPending } : {}),
          };
        }
        return {
          applied: applied.map((a) => ({
            id: a.proposal.id,
            path: a.proposal.path,
            editsApplied: a.edits.length,
            lines: a.lines,
          })),
          ...(stale.length ? { stale } : {}),
          build,
          typeErrors,
          status,
          ...(stillPending.length ? { otherPendingOnPath: stillPending } : {}),
        };
      }),
  }),
  rejectEditRequest: defineAppCommand({
    description:
      'Decline an edit the worker proposed. `reason` is required and is delivered to the ' +
      'worker at the head of its next task, so a proposal turned down for being wrong is ' +
      'not re-sent unchanged — which is the only thing that stops a rejected idea coming ' +
      'back. Nothing is written either way.',
    params: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'The proposal id.' },
        reason: {
          type: 'string',
          description:
            'Why, concretely enough for the worker to do better: what it missed, or what ' +
            'you want instead. "No" teaches it nothing.',
        },
      },
      required: ['id', 'reason'],
    },
    replay: 'never',
    run: async (p) => {
      const id = Number(p.id);
      const reason = String(p.reason ?? '').trim();
      const proposal = findProposal(id);
      if (!proposal) throw new AppCommandError('No edit request #' + id + '.');
      if (proposal.status !== 'pending') {
        throw new AppCommandError(
          'Edit request #' +
            id +
            ' is already ' +
            proposal.status +
            ', so there is nothing to decline. The worker has already been told how it ' +
            'ended — an accept, a rejection and a failed apply each queue their own ' +
            'feedback for its next task, so no explanation is owed here.',
        );
      }
      if (reason.length < 8) {
        throw new AppCommandError(
          'reason must say why — the worker reads it before its next task.',
        );
      }
      resolveProposal(id, 'rejected', reason);
      queueWorkerFeedback(
        'Edit request #' + id + ' (' + proposal.path + ') was rejected: ' + reason,
        proposal.worker,
      );
      return {
        id,
        status: 'rejected',
        reason,
        pending: workerProposals().filter((q) => q.status === 'pending').length,
      };
    },
  }),
  'persona:edit_request': defineAppCommand({
    description:
      "Called by the worker sub-agent's edit_request tool: one proposed edit, dry-run and " +
      'parked for the caller. Never writes.',
    params: {
      type: 'object',
      properties: {
        personaId: { type: 'string' },
        path: { type: 'string' },
        edits: { type: 'string' },
        rationale: { type: 'string' },
        notify: { type: 'boolean' },
      },
      required: ['personaId', 'path', 'edits'],
    },
    replay: 'never',
    run: async (p) => {
      const path = String(p.path ?? '');
      const personaId = String(p.personaId ?? '');
      noteWorkerToolCall('edit_request ' + path, personaId);
      if (!activeProject()) return NO_PROJECT;
      return addWorkerEditRequest({
        path,
        editsJson: String(p.edits ?? ''),
        rationale: String(p.rationale ?? ''),
        notify: p.notify === true,
        personaId,
      });
    },
  }),
  'persona:list_files': defineAppCommand({
    description:
      "Called by the worker sub-agent's list_files tool: the active project's file listing.",
    params: {
      type: 'object',
      properties: { personaId: { type: 'string' } },
      required: ['personaId'],
    },
    replay: 'never',
    run: async (p) => {
      noteWorkerToolCall('list_files', String(p.personaId ?? ''));
      const proj = activeProject();
      if (!proj) return NO_PROJECT;
      const lines = files()
        .filter((f) => !f.isDirectory)
        .map((f) =>
          f.lines !== undefined
            ? `${f.path} (${f.lines} lines)`
            : `${f.path} (${f.bytes ?? '?'} bytes, binary)`,
        );
      return `Project "${proj.name}" — ${lines.length} files:\n${lines.join('\n')}`;
    },
  }),
  'persona:read_file': defineAppCommand({
    description:
      "Called by the worker sub-agent's read_file tool: one project file, line-numbered.",
    params: {
      type: 'object',
      properties: {
        personaId: { type: 'string' },
        path: { type: 'string' },
        start_line: { type: 'number' },
        end_line: { type: 'number' },
      },
      required: ['personaId', 'path'],
    },
    replay: 'never',
    run: async (p) => {
      const path = String(p.path);
      noteWorkerToolCall(`read_file ${path}`, String(p.personaId ?? ''));
      if (!activeProject()) return NO_PROJECT;
      try {
        const result = await readFileContent(path, {
          startLine: p.start_line != null ? Number(p.start_line) : undefined,
          endLine: p.end_line != null ? Number(p.end_line) : undefined,
          lineNum: true,
        });
        return (
          result.content + noteWorkerRead(String(p.personaId ?? ''), path, result.content.length)
        );
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  }),
  'persona:report': defineAppCommand({
    description:
      "Called by the worker sub-agent's report tool: one interim finding, delivered mid-turn.",
    params: {
      type: 'object',
      properties: {
        personaId: { type: 'string' },
        finding: { type: 'string' },
        notify: { type: 'boolean' },
      },
      required: ['personaId', 'finding'],
    },
    replay: 'never',
    // The only handler here that does not touch the project: a report is the
    // worker talking, not the worker looking. No `noteWorkerToolCall` either —
    // `addWorkerReport` files its own transcript line and feeds the watchdog,
    // and a "⚙ report" line above every finding would be noise.
    run: async (p) =>
      addWorkerReport(String(p.finding ?? ''), p.notify === true, String(p.personaId ?? '')),
  }),
  'persona:grep': defineAppCommand({
    description: "Called by the worker sub-agent's grep tool: regex search across the project.",
    params: {
      type: 'object',
      properties: {
        personaId: { type: 'string' },
        pattern: { type: 'string' },
        glob: { type: 'string' },
      },
      required: ['personaId', 'pattern'],
    },
    replay: 'never',
    run: async (p) => {
      const pattern = String(p.pattern);
      noteWorkerToolCall(
        `grep /${pattern}/${p.glob ? ` in ${p.glob}` : ''}`,
        String(p.personaId ?? ''),
      );
      if (!activeProject()) return NO_PROJECT;
      // Generated output stays filtered out for the worker with no way to ask for it: it
      // explores source, and a minified bundle line would eat its context for nothing.
      const result = await grep(pattern, p.glob ? String(p.glob) : undefined);
      if (result.matches.length === 0) {
        noteWorkerGrep(String(p.personaId ?? ''), pattern, p.glob ? String(p.glob) : undefined, []);
        return result.excluded
          ? `No matches in source (${result.excluded} were in generated output, which this tool skips).`
          : 'No matches found.';
      }
      const lines = result.matches.map((m) => `${m.file}:${m.line}│${m.content}`);
      const nudge = noteWorkerGrep(
        String(p.personaId ?? ''),
        pattern,
        p.glob ? String(p.glob) : undefined,
        lines,
      );
      const body = lines.join('\n');
      return (result.truncated ? `${body}\n(results truncated)` : body) + nudge;
    },
  }),
};
