export {};
import { AppCommandError, defineAppCommand } from '@bundled/yaar';
import {
  activeProject,
  bundleStatus,
  compileErrors,
  diagnostics,
  files,
  typecheckState,
} from '../core';
import { applyEdits } from '../lib/edits';
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
  NO_ACTIVE_PROJECT,
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

/**
 * Apply an accepted proposal and hand back what changed, or throw.
 *
 * Applied here rather than through the `editFile` service so the write carries
 * the proposal's number into the change history: the Changes panel is the only
 * place a human sees that an edit came from the worker rather than from the
 * agent they were talking to.
 */
async function applyProposal(
  id: number,
  path: string,
  edits: Parameters<typeof applyEdits>[1],
): Promise<{ before: string; after: string }> {
  const before = await readFileText(path);
  if (before === null) throw new AppCommandError('No such file in the active project: ' + path);
  const { content: after } = applyEdits(before, edits, { requireUnique: true });
  await writeFile(path, after, { before, label: 'worker edit #' + id });
  return { before, after };
}

/** Type errors right now, and whether that number means anything yet. */
function typeErrorCount(): { count: number; reliable: boolean } {
  return {
    count: diagnostics().filter((d) => d.severity === 'error').length,
    reliable: typecheckState() !== 'unknown',
  };
}

export const workerCommands = {
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
      'done. A very long answer can reach you marked "[truncated, N chars]" — the wakeup is a ' +
      'prompt injection with a context budget; call workerWait with the taskId to read the ' +
      'full record, which is kept whole. The worker keeps its memory across tasks; follow-ups like "now check the other ' +
      'file" work, and `fresh` is how you opt out of that. One task at a time — starting ' +
      'another while one runs is a refusal, not a queue.',
    params: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'The task, self-contained — the worker sees none of your context.',
        },
        fresh: {
          type: 'boolean',
          description:
            'Retire the worker first, so this task starts with no memory of earlier ones. ' +
            'Use when its context has gone stale or an earlier answer was wrong and you do ' +
            'not want this one built on it. Costs a respawn; the default (false) is right ' +
            'for a follow-up.',
        },
      },
      required: ['task'],
    },
    replay: 'never',
    run: async (p) => {
      // `wakeAgent` is what separates this call from the same task typed into the
      // Worker panel: the agent asked, so the agent is woken when it settles.
      const started = await startWorkerTask(String(p.task), {
        wakeAgent: true,
        ...(p.fresh === true ? { fresh: true } : {}),
      });
      if (started.error) throw new AppCommandError(started.error);
      return {
        taskId: started.taskId,
        status: 'running',
        collect:
          `You will be woken with the answer (channel "worker", taskId ${started.taskId}). ` +
          'To block for it instead, call workerWait.',
      };
    },
  }),
  workerInterrupt: defineAppCommand({
    description:
      'Stop the task the worker is running and take whatever it has produced so far — its ' +
      'partial answer and every interim report. Use it when a report or a state-key read ' +
      'shows the task was mis-scoped: a wrong path list, a pattern that matches nothing, an ' +
      'instruction resting on something untrue. Stopping and re-sending a corrected task ' +
      'beats waiting out a turn you already know is wrong. The worker keeps its memory, so ' +
      'the retry can say "same as before, but under src/ this time".',
    params: { type: 'object', properties: {} },
    replay: 'never',
    run: async () => interruptWorker(),
  }),
  workerWait: defineAppCommand({
    description:
      'Collect a task started by workerTask: returns its answer, or `done: false` if it is ' +
      'still working. Blocks up to waitMs (default 60000, max 170000) — always pass a ' +
      'timeoutMs at least 10s larger than waitMs, or the platform kills the call before the ' +
      'wait ends. Timing out is cheap: the task keeps running and calling again resumes the ' +
      'wait, so a long survey can be collected in slices. Omit taskId to ask about the task ' +
      'in flight (or the last one to finish). Never re-send a task to "retry" a wait. ' +
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
      'Read one edit the worker proposed, whole: the file, the rationale, and the exact ' +
      'search/replace steps. The `worker` state key and a task result list proposals as ' +
      'summaries; this is where the bodies are. It also returns the `token` that ' +
      'acceptEditRequest requires, which is the point of the command — an edit cannot be ' +
      'applied without having been read, so accepting one is never cheaper than looking at ' +
      'it. Reading costs nothing and does not commit you.',
    params: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'The proposal id, as the summaries report it.' },
      },
      required: ['id'],
    },
    replay: 'never',
    run: async (p) => {
      const id = Number(p.id);
      const proposal = findProposal(id);
      if (!proposal) {
        throw new AppCommandError(
          'No edit request #' +
            id +
            '. Read the `worker` state key for the ones that exist; resetting the worker ' +
            'clears them along with its transcript.',
        );
      }
      return {
        id: proposal.id,
        taskId: proposal.taskId,
        path: proposal.path,
        status: proposal.status,
        rationale: proposal.rationale,
        edits: proposal.edits,
        token: proposal.token,
        ...(proposal.resolution ? { resolution: proposal.resolution } : {}),
      };
    },
  }),
  acceptEditRequest: defineAppCommand({
    description:
      'Apply an edit the worker proposed, then type check and compile. Requires the `token` ' +
      'from readEditRequest and a one-line `intent` in your own words, because an accept is ' +
      'supposed to be a judgement and not a forward. Re-checks the edits against the file ' +
      'first — the project may have moved since the proposal was made — and refuses without ' +
      'writing if they no longer apply. If the bundle then fails, or type errors increase, ' +
      'the file is restored, the project is rebuilt clean, and the result comes back with ' +
      '`rolledBack: true` and the `failure` that caused it — a broken build never survives this ' +
      'command. The write is recorded in the Changes panel labelled with the proposal ' +
      'number. Slow (up to two builds): pass timeoutMs, e.g. 120000.',
    params: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'The proposal id.' },
        token: {
          type: 'string',
          description: 'The token readEditRequest returned for this proposal.',
        },
        intent: {
          type: 'string',
          description:
            'One line, yours: what this edit does and why you are taking it. Recorded with ' +
            'the proposal and sent back to the worker.',
        },
      },
      required: ['id', 'token', 'intent'],
    },
    replay: 'never',
    run: async (p) => {
      if (!activeProject())
        throw new AppCommandError('No active project. Open or create one first.');
      const id = Number(p.id);
      const intent = String(p.intent ?? '').trim();
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
      if (String(p.token ?? '') !== proposal.token) {
        throw new AppCommandError(
          'Wrong token for edit request #' +
            id +
            '. Call readEditRequest first and pass the ' +
            'token it returns — this command will not apply an edit you have not read.',
        );
      }
      if (intent.length < 12) {
        throw new AppCommandError(
          'intent must say something. One line in your own words about what this edit does ' +
            'and why you are taking it.',
        );
      }

      // The proposal was checked when it was submitted, against the file as it was
      // then. Anything since — another accept, an editFile of your own, a project
      // switch — may have invalidated it, and an anchor that no longer matches is
      // the thing this catches before a write rather than after one.
      const recheck = await validateProposedEdits(proposal.path, proposal.edits);
      if (!recheck.ok) {
        resolveProposal(id, 'failed', 'Stale at accept: ' + recheck.error);
        queueWorkerFeedback(
          'Edit request #' +
            id +
            ' could not be applied — ' +
            recheck.error +
            ' The file changed after you proposed it. Re-read it before proposing again.',
        );
        throw new AppCommandError(
          'Edit request #' + id + ' no longer applies: ' + recheck.error + ' Nothing was written.',
        );
      }

      const baseline = typeErrorCount();
      const applied = await applyProposal(id, proposal.path, proposal.edits);
      await typecheck();
      await compile();

      const built = bundleStatus() === 'success';
      const after = typeErrorCount();
      // Two different failures, and only one of them is this edit's fault. A bundle
      // that stopped building is: Bun built before and does not now. A type error
      // count is only evidence if a typecheck had run before the edit — otherwise
      // the errors may be older than the proposal, and rolling back on them would
      // discard a good edit to hide someone else's mess.
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
        await writeFile(proposal.path, applied.before, {
          before: applied.after,
          label: 'revert worker edit #' + id,
        });
        await typecheck();
        await compile();
        resolveProposal(id, 'failed', 'Applied and rolled back: ' + why);
        queueWorkerFeedback(
          'Edit request #' +
            id +
            ' was applied and rolled back because ' +
            why +
            '. ' +
            (failure.length ? 'First error: ' + JSON.stringify(failure[0]) + '. ' : '') +
            'Read the file again and check what your replacement text broke.',
        );
        return {
          applied: false,
          rolledBack: true,
          id,
          path: proposal.path,
          reason: why,
          failure,
        };
      }

      resolveProposal(id, 'accepted', intent);
      queueWorkerFeedback('Edit request #' + id + ' was accepted and applied. ' + intent);
      return {
        applied: true,
        id,
        path: proposal.path,
        editsApplied: proposal.edits.length,
        lines: recheck.lines,
        typeErrors: after.count,
        status: after.count === 0 ? 'success' : 'error',
      };
    },
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
        // Spelled out because the obvious reading of a bare refusal is that the
        // worker is now owed an explanation nobody can deliver. It is not: every
        // terminal status queues its own feedback on the way there.
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
      noteWorkerToolCall('edit_request ' + path);
      if (!activeProject()) return NO_PROJECT;
      return addWorkerEditRequest({
        path,
        editsJson: String(p.edits ?? ''),
        rationale: String(p.rationale ?? ''),
        notify: p.notify === true,
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
    run: async () => {
      noteWorkerToolCall('list_files');
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
      noteWorkerToolCall(`read_file ${path}`);
      if (!activeProject()) return NO_PROJECT;
      const result = await readFileContent(path, {
        startLine: p.start_line != null ? Number(p.start_line) : undefined,
        endLine: p.end_line != null ? Number(p.end_line) : undefined,
        lineNum: true,
      });
      return result.content;
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
    run: async (p) => addWorkerReport(String(p.finding ?? ''), p.notify === true),
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
      noteWorkerToolCall(`grep /${pattern}/${p.glob ? ` in ${p.glob}` : ''}`);
      if (!activeProject()) return NO_PROJECT;
      // Generated output stays filtered out for the worker with no way to ask for it: it
      // explores source, and a minified bundle line would eat its context for nothing.
      const result = await grep(pattern, p.glob ? String(p.glob) : undefined);
      if (result.matches.length === 0) {
        return result.excluded
          ? `No matches in source (${result.excluded} were in generated output, which this tool skips).`
          : 'No matches found.';
      }
      const body = result.matches.map((m) => `${m.file}:${m.line}│${m.content}`).join('\n');
      return result.truncated ? `${body}\n(results truncated)` : body;
    },
  }),
};
