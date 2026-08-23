export {};
import { createSignal, batch } from '@bundled/solid-js';
import { app, invoke, read, del, stream, errMsg, type StreamFrame } from '@bundled/yaar';
import * as z from '@bundled/zod';
import { activeProject } from '../core';
import { applyEdits, type EditSpec } from '../lib/edits';
import { PersonaHandleSchema, WorkerEditListSchema, WorkerFrameDataSchema } from '../schema';
import { readFileText } from './files';

// The worker sub-agent — a sonnet-tier explorer devtools spawns for itself via
// `yaar://apps/self/agents` (requires the user-granted `subagents` capability in
// app.json). The worker holds NO YAAR verbs and no filesystem: its only reach is
// the four tools declared at spawn, each of which the server routes back to this
// iframe as a `persona:{name}` command (handlers: protocol/worker.ts, which run
// against devtools' own storage grants). Containment, not plumbing — the worker
// can never see more of the machine than devtools itself shows it.
//
// Three of the five look outward (list_files, read_file, grep). The other two
// look back: `report`, how the worker says something before its turn ends, and
// `edit_request`, how it proposes a change it cannot make. Neither needed a new
// capability, precisely because of the shape above — a tool is already just a
// name over the bridge to this one iframe, so the only agent either can reach is
// devtools' own. See `addWorkerReport` and the Edit requests section for what
// they buy.
//
// One worker, not a cast: the id below is fixed (the manifest's `subagents.max`
// is a ceiling, not a target), and the provider session is persistent —
// successive tasks are turns of one conversation, so "now check the other file"
// works as a follow-up. `reset` is the fresh-context escape hatch.

/** The one persona id. Spawn is idempotent on it, which is what makes reload cheap. */
const WORKER_ID = 'worker';

/**
 * How long a turn may go without any sign of life before we give up on it.
 * "Life" is any stream frame OR any tool-handler invocation — a worker deep in a
 * grep loop produces no text frames, so the tool handlers call `noteWorkerToolCall`
 * to keep the watchdog fed (chitchats only needed frames; a tool-using worker doesn't
 * emit them while a tool call is outstanding).
 */
const TURN_IDLE_TIMEOUT_MS = 180_000;

export type WorkerStatus = 'offline' | 'spawning' | 'idle' | 'running' | 'error';

export interface WorkerEntry {
  kind: 'task' | 'answer' | 'tool' | 'report' | 'edit-request' | 'error';
  text: string;
  timestamp: number;
}

/**
 * How one task ended. `answer` may accompany `error` — the partial draft of a
 * turn that went quiet or was interrupted is worth more than the error alone.
 *
 * Exactly one of `answer`/`error` is always set by the time `settle` is done
 * with it; see the invariant there.
 */
export interface TurnOutcome {
  answer?: string;
  error?: string;
  /** Interim findings the worker posted with its `report` tool during the turn. */
  reports?: string[];
  /** Edits the worker proposed during the turn, as summaries. */
  proposals?: EditProposalSummary[];
}

/**
 * One task, from acceptance to outcome. The id is what makes the task
 * *backgroundable*: `workerTask` hands it back the moment the turn is queued,
 * and every later read — `workerWait`, the `worker` state key — answers about
 * that id rather than about "whatever the worker last said", which is the one
 * ambiguity a fire-and-collect caller cannot resolve on its own.
 */
export interface WorkerTaskRecord {
  id: number;
  task: string;
  startedAt: number;
  /** Set when the task settled; absent while it runs. */
  endedAt?: number;
  answer?: string;
  error?: string;
  /**
   * Interim findings posted with the `report` tool while the turn ran, oldest
   * first.
   *
   * Mutated in place by {@link addWorkerReport} rather than replaced, because
   * this record *is* the one `inflight` holds and the one `settle` spreads —
   * a copy would have to be threaded back into both. Nothing renders it
   * reactively (the panel reads the transcript signal instead), so in-place is
   * safe here in a way it would not be for a signal-backed value.
   */
  reports?: string[];
  /** Edits proposed during the turn, filled in at settle from the proposal list. */
  proposals?: EditProposalSummary[];
  /**
   * Whether the app agent started this one, and so should be woken when it
   * settles. False for a task the user ran from the Worker panel: nobody is
   * waiting on that, and waking an idle opus agent to tell it so costs a turn
   * for nothing.
   */
  wakeAgent?: boolean;
}

export const [workerStatus, setWorkerStatus] = createSignal<WorkerStatus>('offline');
export const [workerEntries, setWorkerEntries] = createSignal<WorkerEntry[]>([]);
/** Accumulated text deltas of the turn in flight. */
export const [workerDraft, setWorkerDraft] = createSignal('');
/** Accumulated thinking deltas — shown behind a fold. */
export const [workerThinking, setWorkerThinking] = createSignal('');
/** The task running right now, or null when the worker is idle. */
export const [workerActiveTask, setWorkerActiveTask] = createSignal<WorkerTaskRecord | null>(null);
/**
 * The most recently *settled* task, answer or error included. Only the last one
 * is kept: the full history is the transcript, and a caller that needs an older
 * answer is asking a question `workerEntries` already answers.
 */
export const [workerLastResult, setWorkerLastResult] = createSignal<WorkerTaskRecord | null>(null);

/** Unsubscribe thunk for the live stream. Not reactive — nothing renders it. */
let stopStream: (() => void) | null = null;
/**
 * The turn in flight, settled by the stream's terminal frame or the watchdog.
 * `waiters` is a list rather than one resolver because nobody owns the turn any
 * more: the panel starts a task and never waits, the app agent starts one and
 * may wait twice (once, time out, wait again), and both must see the same end.
 */
let inflight: {
  record: WorkerTaskRecord;
  timer: ReturnType<typeof setTimeout>;
  /** Returns whether it actually delivered — a waiter whose own wait already
   * timed out returns false, which is what keeps the wakeup below honest. */
  waiters: Array<(outcome: TurnOutcome) => boolean>;
} | null = null;
/** A spawn in flight, so two rapid Run clicks don't race two spawns. */
let spawning: Promise<void> | null = null;
/** Monotonic task ids, per iframe lifetime. Restart on remount is fine — the
 * worker's own session is what carries memory, and ids are only ever compared
 * against the two records above. */
let taskSeq = 0;

function appendEntry(kind: WorkerEntry['kind'], text: string): void {
  setWorkerEntries([...workerEntries(), { kind, text, timestamp: Date.now() }]);
}

/**
 * Why a task that produced no answer is an *error* and never a quiet success.
 *
 * A survey is very often a search for negative results — "most of these files
 * are clean" is a real and expected answer — so a settled task carrying neither
 * `answer` nor `error` is indistinguishable from "nothing found". A caller that
 * takes it at face value concludes there was nothing to do and ships a no-op.
 * The turn cost minutes and told us nothing; saying so is the only honest
 * report.
 */
function noAnswerError(reports: string[]): string {
  return reports.length
    ? `The worker ended its turn without a final answer. This is NOT "nothing found" — ` +
        `${reports.length} interim report${reports.length === 1 ? '' : 's'} arrived before it ` +
        'stopped and are included as `reports`; treat those as partial results and re-run only ' +
        'what they do not cover.'
    : 'The worker ended its turn without a final answer and posted no interim reports. This is ' +
        'NOT "nothing found" — nothing was learned. Re-run the task in smaller slices, and tell ' +
        'the worker to report as it goes.';
}

/** Settle the turn in flight once, whatever ended it, and stop its watchdog. */
function settle(outcome: TurnOutcome): void {
  if (!inflight) return;
  clearTimeout(inflight.timer);
  const { record, waiters } = inflight;
  inflight = null;
  const reports = record.reports ?? [];
  const answer = outcome.answer?.trim() || undefined;
  // The invariant every reader of this module depends on: a settled task
  // reports *something*. Callers of `settle` normally name the shortfall
  // themselves (they know whether the turn was interrupted, went quiet, or just
  // came back empty); this is the backstop for the path that forgets to, and
  // for any added later.
  const error = outcome.error ?? (answer ? undefined : noAnswerError(reports));
  // Proposals ride out with the result for the same reason reports do: a task
  // whose whole product is a proposed edit has produced something even if its
  // answer was lost, and the caller cannot act on what it is not told about.
  const proposals = proposalsOfTask(record.id);
  const settled: TurnOutcome = {
    ...(answer ? { answer } : {}),
    ...(error ? { error } : {}),
    ...(reports.length ? { reports } : {}),
    ...(proposals.length ? { proposals } : {}),
  };
  const finished: WorkerTaskRecord = { ...record, endedAt: Date.now(), ...settled };
  batch(() => {
    setWorkerActiveTask(null);
    setWorkerLastResult(finished);
  });
  let served = false;
  for (const resolve of waiters) served = resolve(settled) || served;

  // The event goes out either way — a subscriber watching this channel wants
  // every settle. What is conditional is the *wakeup*, and on two things: the
  // agent started this task, and no `workerWait` of its own just answered it.
  // Without the second, an agent that chose to block would be woken a turn later
  // to be told what it had already been handed.
  app?.emit(
    'worker',
    {
      kind: 'result',
      taskId: finished.id,
      task: finished.task,
      ...(finished.answer ? { answer: finished.answer } : {}),
      ...(finished.error ? { error: finished.error } : {}),
      ...(reports.length ? { reports } : {}),
      ...(proposals.length ? { proposals } : {}),
      elapsedMs: (finished.endedAt ?? Date.now()) - finished.startedAt,
    },
    { wakeAgent: !!finished.wakeAgent && !served },
  );
}

/** Restart the silence watchdog — any frame or tool call counts as progress. */
function keepAlive(): void {
  if (!inflight) return;
  clearTimeout(inflight.timer);
  inflight.timer = setTimeout(() => {
    const draft = workerDraft().trim();
    batch(() => {
      appendEntry('error', `Worker went quiet${draft ? ` — partial answer kept:\n${draft}` : ''}.`);
      setWorkerDraft('');
      setWorkerStatus('idle');
    });
    settle({ error: 'The worker went quiet.', ...(draft ? { answer: draft } : {}) });
  }, TURN_IDLE_TIMEOUT_MS);
}

/**
 * Tool handlers report in here (protocol/worker.ts). It is how a tool-calling
 * stretch of the turn shows up in the transcript, and how it feeds the watchdog.
 */
export function noteWorkerToolCall(summary: string): void {
  appendEntry('tool', summary);
  keepAlive();
}

/**
 * Take one interim finding from the worker, mid-turn.
 *
 * This is the whole of the worker→caller channel, and it is deliberately not a
 * new capability: `report` is an app-declared tool like `grep`, so it arrives
 * over the same bridge and lands in the same iframe. Its only reach is this
 * function, which means the one agent it can ever reach is devtools' own.
 *
 * It buys three things a final answer alone cannot:
 *
 * 1. **Partial results survive.** A turn whose answer is lost to a size cap or
 *    an interrupt still delivered everything reported before it. The failure
 *    degrades from "nothing" to "some".
 * 2. **Course correction happens early.** A mis-scoped task announces itself at
 *    the first report rather than at the end, and `workerInterrupt` is how the
 *    caller acts on that.
 * 3. **Progress is legible.** The transcript gains findings, not just an
 *    `elapsedMs` that ticks up.
 *
 * `notify` is the difference between posting and interrupting: it wakes the app
 * agent (as `settle` does), and so is worth a turn of an opus agent's attention.
 * Routine progress leaves it off and is simply collected with the result.
 * A report on a task the *user* started never wakes anyone, by the same rule
 * `settle` follows.
 */
export function addWorkerReport(finding: string, notify = false): string {
  const text = finding.trim();
  if (!text) return 'Empty report — nothing recorded. Say what you found, or say nothing.';
  if (!inflight) {
    // Kept in the transcript rather than dropped: a report with no turn behind
    // it is strange enough that hiding it would make the next bug harder.
    appendEntry('report', text);
    return 'Recorded, but no task is in flight — nobody is waiting on this.';
  }

  const { record } = inflight;
  const reports = (record.reports ??= []);
  reports.push(text);
  appendEntry('report', text);
  keepAlive();

  const wakeAgent = !!record.wakeAgent && notify;
  app?.emit(
    'worker',
    {
      kind: 'report',
      taskId: record.id,
      task: record.task,
      report: text,
      reportIndex: reports.length,
      elapsedMs: Date.now() - record.startedAt,
    },
    { wakeAgent },
  );

  return wakeAgent
    ? `Report #${reports.length} delivered — the caller has been interrupted to read it. Keep working unless it tells you otherwise.`
    : `Report #${reports.length} recorded. It reaches the caller with your final answer, or in place of it if this turn cannot finish.`;
}

// ── Edit requests ─────────────────────────────────────────────────────────────
//
// The worker reads the project but cannot write to it, and its prompt has always
// asked it to describe the precise edit it would make so the caller could apply
// it. That description arrived as prose, which meant the main agent re-typed the
// whole thing as `editFile` params — so delegating a survey saved reading tokens
// and spent them all again on output. `edit_request` is that same instruction
// given a shape: the worker submits EditSpecs, the main agent accepts or rejects
// an id.
//
// Two properties keep this from being a write door in disguise:
//
// 1. **Nothing is applied here.** A submission is dry-run against the file and
//    then parked. `acceptEditRequest` (protocol/worker.ts) is the only writer.
// 2. **The dry run is the worker's own feedback loop.** A `persona:*` handler's
//    return value lands in the worker's turn as a tool result, so a mismatched
//    search string or an ambiguous one comes back while the worker still has the
//    file in context and can fix it. Only proposals that already apply cleanly
//    ever reach the main agent.

/** Every proposal a settled worker turn leaves behind, capped like the transcript. */
const MAX_PROPOSALS = 40;

/**
 * Refused as a string the worker can act on, not thrown: a missing project is a
 * normal state mid-conversation (the user closed it), and an error would read as
 * the tool being broken rather than the project being gone.
 */
export const NO_ACTIVE_PROJECT = 'No project is active in Dev Tools right now. Say so and stop.';

/** A change the worker proposes and cannot make. */
export interface EditProposal {
  id: number;
  /** The task it came out of, or null for one submitted with no turn in flight. */
  taskId: number | null;
  path: string;
  edits: EditSpec[];
  rationale: string;
  createdAt: number;
  status: 'pending' | 'accepted' | 'rejected' | 'failed';
  /**
   * The read gate. `readEditRequest` is the only command that serves this, and
   * `acceptEditRequest` refuses without it — so an accept is proof the payload
   * passed through the main agent's context, which is the property that keeps
   * "the agent that verifies is the agent that applies" true once the main agent
   * stopped having to retype the edits.
   *
   * A discipline gate, not a security boundary: the worker is subordinate and
   * already inside this iframe. It exists to make rubber-stamping take more
   * effort than reading, not to withstand an adversary.
   */
  token: string;
  /** Why it was rejected, or how applying it went. */
  resolution?: string;
}

/** What a list of proposals says without quoting their bodies. */
export interface EditProposalSummary {
  id: number;
  path: string;
  edits: number;
  rationale: string;
  status: EditProposal['status'];
}

export const [workerProposals, setWorkerProposals] = createSignal<EditProposal[]>([]);
let proposalSeq = 0;

/**
 * Feedback owed to the worker, delivered at the head of its next task.
 *
 * A rejection lands after the turn that proposed it has ended, and the server
 * takes no message while a turn is not running — so the alternative to a queue
 * is a worker that proposes the same rejected edit again next task. Drained by
 * `startWorkerTask`.
 */
let pendingFeedback: string[] = [];

/** FNV-1a over the proposal body. Short, stable, and not derivable from a summary. */
function proposalToken(path: string, rationale: string, edits: EditSpec[]): string {
  const source = `${path} ${rationale} ${JSON.stringify(edits)}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, '0');
}

/**
 * A summary carries the rationale and never the edit bodies: `readEditRequest` is
 * where those live, and an accept is supposed to cost a deliberate read. The cap is
 * therefore sized to fit a whole rationale rather than to save room — one cut
 * mid-sentence is worse than useless, since it reads as a complete thought.
 */
export function summarizeProposal(p: EditProposal): EditProposalSummary {
  const rationale = p.rationale.length > 500 ? `${p.rationale.slice(0, 500)}…` : p.rationale;
  return { id: p.id, path: p.path, edits: p.edits.length, rationale, status: p.status };
}

export function findProposal(id: number): EditProposal | undefined {
  return workerProposals().find((p) => p.id === id);
}

/** Move a proposal out of `pending`, keeping the record for the transcript. */
export function resolveProposal(
  id: number,
  status: EditProposal['status'],
  resolution: string,
): void {
  setWorkerProposals(
    workerProposals().map((p) => (p.id === id ? { ...p, status, resolution } : p)),
  );
}

/** Tell the worker how one of its proposals ended, at the start of its next task. */
export function queueWorkerFeedback(line: string): void {
  pendingFeedback.push(line);
}

/** What a dry run concluded: the edits apply, or the reason they do not. */
export interface ProposalCheck {
  ok: boolean;
  error?: string;
  lines?: number;
}

/**
 * Apply the edits in memory and throw nothing away — the check both `edit_request`
 * and `acceptEditRequest` run, for different reasons. At submission it is the
 * worker's correction loop; at accept it is the staleness check, because the file
 * may have moved under the proposal in between.
 *
 * `requireUnique` is on: a search string that matches twice would splice into
 * whichever came first, and the worker is not there to notice.
 */
export async function validateProposedEdits(
  path: string,
  edits: EditSpec[],
): Promise<ProposalCheck> {
  if (!activeProject()) return { ok: false, error: NO_ACTIVE_PROJECT };
  const content = await readFileText(path);
  if (content === null) {
    return { ok: false, error: `No such file in the active project: ${path}` };
  }
  try {
    const { content: updated } = applyEdits(content, edits, { requireUnique: true });
    if (updated === content) {
      return { ok: false, error: 'These edits leave the file byte-identical — nothing to apply.' };
    }
    return { ok: true, lines: updated.split('\n').length };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
}

/**
 * Take one proposed edit from the worker, dry-run it, and park it for the caller.
 *
 * Returns the string the worker reads as its tool result — which is the whole
 * point of validating here rather than at accept: a rejection it can act on
 * arrives inside the turn that can still fix it.
 */
export async function addWorkerEditRequest(input: {
  path: string;
  editsJson: string;
  rationale: string;
  notify?: boolean;
}): Promise<string> {
  const path = input.path.trim();
  const rationale = input.rationale.trim();
  if (!path) return 'No path given — say which file this edit is for.';
  if (!rationale) {
    return 'No rationale given. Say why this edit is right; the caller decides from it.';
  }

  let raw: unknown;
  try {
    raw = JSON.parse(input.editsJson);
  } catch (err) {
    return `edits is not valid JSON (${errMsg(err)}). Send an array of edit objects, e.g. [{"search":"old text","replace":"new text"}].`;
  }
  const parsed = z.safeParse(WorkerEditListSchema, raw);
  if (!parsed.success) {
    return 'edits must be an array of objects, each with search+replace or startLine+endLine+anchor.';
  }
  if (parsed.data.length === 0) return 'edits is empty — nothing to propose.';

  // Normalize the aliases once, so everything downstream (the dry run, the stored
  // record, the accept) sees one spelling.
  const edits: EditSpec[] = parsed.data.map((e) => ({
    ...(e.search !== undefined || e.oldString !== undefined
      ? { search: e.search ?? e.oldString }
      : {}),
    ...(e.replace !== undefined || e.newString !== undefined
      ? { replace: e.replace ?? e.newString }
      : {}),
    ...(e.startLine !== undefined ? { startLine: e.startLine } : {}),
    ...(e.endLine !== undefined ? { endLine: e.endLine } : {}),
    ...(e.anchor !== undefined ? { anchor: e.anchor } : {}),
  }));

  const check = await validateProposedEdits(path, edits);
  if (!check.ok) {
    // Not recorded: a proposal that does not apply is not a proposal, and parking
    // it would spend the caller's attention on the worker's typo.
    return `Not submitted — ${check.error} Re-read the file and try again; nothing was changed.`;
  }

  const proposal: EditProposal = {
    id: ++proposalSeq,
    taskId: inflight?.record.id ?? null,
    path,
    edits,
    rationale,
    createdAt: Date.now(),
    status: 'pending',
    token: proposalToken(path, rationale, edits),
  };
  setWorkerProposals([...workerProposals(), proposal].slice(-MAX_PROPOSALS));
  appendEntry(
    'edit-request',
    `#${proposal.id} ${path} · ${edits.length} edit${edits.length === 1 ? '' : 's'}\n${rationale}`,
  );
  keepAlive();

  const wakeAgent = !!inflight?.record.wakeAgent && input.notify === true;
  app?.emit(
    'worker',
    {
      kind: 'edit-request',
      taskId: proposal.taskId,
      proposal: summarizeProposal(proposal),
      elapsedMs: inflight ? Date.now() - inflight.record.startedAt : 0,
    },
    { wakeAgent },
  );

  return (
    `Edit request #${proposal.id} submitted and verified against ${path} — it applies cleanly ` +
    `(${check.lines} lines after). The caller decides whether to apply it; you cannot. ` +
    'Keep working, and still describe this change in your final answer.'
  );
}

/** The proposals one task produced, for the result it settles with. */
function proposalsOfTask(taskId: number): EditProposalSummary[] {
  return workerProposals()
    .filter((p) => p.taskId === taskId)
    .map(summarizeProposal);
}

/** Fold one stream frame into the panel state; settle the turn on a terminal. */
function onFrame(frame: StreamFrame): void {
  const parsed = z.safeParse(WorkerFrameDataSchema, frame.data ?? {});
  if (!parsed.success) {
    console.warn('[devtools] unreadable worker frame', frame.kind, frame.data);
    return;
  }
  const data = parsed.data;
  keepAlive();

  switch (frame.kind) {
    case 'start':
      batch(() => {
        setWorkerDraft('');
        setWorkerThinking('');
        setWorkerStatus('running');
      });
      break;
    case 'text':
      setWorkerDraft(workerDraft() + (data.delta ?? ''));
      break;
    case 'thinking':
      setWorkerThinking(workerThinking() + (data.delta ?? ''));
      break;
    case 'done': {
      // `done` carries the authoritative final text; the draft is the fallback
      // for a stream that dropped a delta.
      const text = (data.text ?? workerDraft()).trim();
      // Neither one, and the frame was capped in transit: the answer exists and
      // is simply too big for one frame. That is a different fact from an empty
      // turn and must never be reported as one — go get it from the persona
      // itself, which keeps the last turn's final text for exactly this case.
      if (!text && data.truncated) {
        batch(() => {
          setWorkerDraft('');
          setWorkerStatus('idle');
        });
        void settleFromPersonaRead();
        break;
      }
      // Two ways a `done` frame is not the success it looks like: no text at
      // all, and a turn the server stopped rather than finished. Named here,
      // where the frame is, so `settle`'s backstop stays a backstop.
      const shortfall = !text
        ? noAnswerError(inflight?.record.reports ?? [])
        : data.status === 'interrupted'
          ? 'The turn was interrupted before the worker finished — the answer is partial.'
          : undefined;
      batch(() => {
        if (text) appendEntry('answer', text);
        if (shortfall) appendEntry('error', shortfall);
        setWorkerDraft('');
        setWorkerStatus('idle');
      });
      settle({ ...(text ? { answer: text } : {}), ...(shortfall ? { error: shortfall } : {}) });
      break;
    }
    case 'error': {
      const message =
        data.error ??
        (data.truncated
          ? 'The worker’s turn failed with an error too large to fit one stream frame.'
          : 'stream error');
      batch(() => {
        appendEntry('error', message);
        setWorkerDraft('');
        setWorkerStatus('idle');
      });
      settle({ error: message });
      break;
    }
  }
}

/**
 * Recover an answer the `done` frame could not carry, and settle with it.
 *
 * The server keeps the final text of a sub-agent's last completed turn on the
 * persona itself, reachable with a plain `read`, precisely so a subscriber that
 * missed the stream can still collect what the model already paid for. This is
 * that subscriber: the frame arrived, it was over the wire's payload cap, and
 * the cap replaces the whole payload with a marker rather than trimming a field.
 *
 * Safe against reading a *stale* answer, and that is the only reason this is
 * gated on `truncated` rather than on "no text": a capped frame is proof the
 * turn produced text, and the server records it before it publishes the `done`
 * that carried it. A genuinely empty turn leaves an uncapped frame and takes the
 * ordinary path, where an empty answer stays an error.
 */
async function settleFromPersonaRead(): Promise<void> {
  let answer = '';
  let failure = '';
  try {
    const raw = await read(`yaar://apps/self/agents/${WORKER_ID}`);
    const parsed = z.safeParse(PersonaHandleSchema, raw);
    if (!parsed.success) failure = 'reading the worker back returned an unexpected shape';
    else answer = (parsed.data.lastResponse ?? '').trim();
  } catch (err) {
    failure = errMsg(err);
  }

  if (answer) {
    appendEntry('answer', answer);
    settle({ answer });
    return;
  }
  const shortfall =
    'The worker finished with an answer too large for one stream frame, and recovering it ' +
    `from the worker itself ${failure ? `failed (${failure})` : 'came back empty'}. The turn ` +
    'is NOT "nothing found" — re-run it in smaller slices, and tell the worker to report as ' +
    'it goes so the findings arrive before the answer does.';
  appendEntry('error', shortfall);
  settle({ error: shortfall });
}

/**
 * The worker's constitution. Written to the worker, in the second person — this
 * is the whole system prompt, used verbatim (the platform appends nothing).
 *
 * Project-agnostic on purpose: the persona is spawned once and its prompt is
 * fixed for its lifetime, but the user can switch the active project between
 * tasks. The tools always answer for the project active *now*, so the prompt
 * tells the worker to trust the tools over its own memory.
 */
const WORKER_PROMPT = `You are the Dev Tools worker: a fast, subordinate explorer inside YAAR's Dev Tools IDE.
Each message is one task about the currently active app project — a small web app built from
TypeScript/Solid.js sources, an app.json manifest, and assets.

Method: use your tools before answering, never memory alone. list_files when you don't know the
layout, grep to locate, read_file to confirm. The active project can be switched between tasks;
your tools always answer for the project as it is now, so when results look inconsistent with
what you remember, re-list rather than arguing with the tools.

You cannot edit files, compile, or run anything. When a task needs a change, submit it with the
edit_request tool rather than describing it in prose: the caller applies your exact search and
replace instead of retyping it, which is the whole reason the tool exists. Read the file first and
copy the search string out of what read_file showed you, with enough surrounding lines that it
occurs exactly once — a string matching twice is refused, because replacing the first match would
be a guess. The tool answers you either way, so a refusal is yours to fix and resubmit in this same
turn. Still describe the change in your final answer: the caller decides from that.

Report as you go with the report tool — after each batch of files, not saved up for the end. Two
reasons, both real: your final answer can be lost whole to a size cap, while a report already
delivered cannot; and a task that turns out to be mis-scoped (the files named do not exist, the
pattern matches nothing, the question rests on something untrue) should say so at the first sign
with notify set, rather than spending the whole turn on it.

Keep your final answer under roughly 2000 words — enough for a real survey with code excerpts, so
do not compress a complete finding down to a summary to stay well clear of it. If the finding
genuinely does not fit, report the bulk in slices as you go and make the final answer a summary of
what you reported plus anything that did not fit a report. Never end a turn silently: if you found
nothing, say you found nothing and what you looked at — an empty answer is indistinguishable from
a crash.

Answer concretely and completely, citing locations as path:line (e.g. src/main.ts:42). No
padding, no restating the task.`;

/** The spawn-time tool list. Descriptions are written to the worker, second person. */
const WORKER_TOOLS = [
  {
    name: 'list_files',
    description:
      'List every file in the active project as "path (N lines)" (binary files show bytes). ' +
      'Call this first whenever you are unsure of the layout, and again after anything ' +
      'looks inconsistent — the active project may have been switched between tasks.',
  },
  {
    name: 'read_file',
    description:
      'Read one file of the active project, line-numbered. Omit the range to read all of it; ' +
      'pass start_line/end_line (1-based, inclusive) to read a slice of a long file.',
    input: {
      path: { type: 'string', description: 'Project-relative path, e.g. src/main.ts.' },
      start_line: { type: 'number', description: 'First line, 1-based.', optional: true },
      end_line: { type: 'number', description: 'Last line, inclusive.', optional: true },
    },
  },
  {
    name: 'grep',
    description:
      'Search file contents across the active project with a regex. Returns matches as ' +
      'path:line with the matching line text.',
    input: {
      pattern: { type: 'string', description: 'Regex pattern to search for.' },
      glob: { type: 'string', description: 'File glob filter, e.g. src/**/*.ts.', optional: true },
    },
  },
  {
    name: 'edit_request',
    description:
      'Propose one edit to one file of the active project. You cannot apply it — the caller ' +
      'accepts or rejects it — but sending one saves the caller retyping a change you have ' +
      'already worked out, which is why you should prefer it to describing an edit in prose. ' +
      'Every request is applied to the file in memory before it is accepted for submission and ' +
      'the outcome is returned to you, so a search string that does not match, or that matches ' +
      'more than once, comes back while you can still fix it. Nothing is written to the file ' +
      'either way. One request per coherent change; batch several steps in the same file into ' +
      'one request rather than sending several.',
    input: {
      path: { type: 'string', description: 'Project-relative path, e.g. src/main.ts.' },
      edits: {
        type: 'string',
        description:
          'A JSON array of edit steps, as a string. Each step is either ' +
          '{"search":"exact current text","replace":"new text"} — the search text copied ' +
          'verbatim from read_file and long enough to occur exactly once — or ' +
          '{"startLine":N,"endLine":M,"anchor":"current text of line N","replace":"new text"}. ' +
          'Omit replace in a line-range step to delete the lines. Steps apply in order, each ' +
          'to the text the one before it left.',
      },
      rationale: {
        type: 'string',
        description:
          'Why this edit is right, in a sentence or two. The caller decides from this, so ' +
          'say what is wrong now rather than restating the diff. Plain prose, not JSON: ' +
          'this field is read as text, so write quotes and backslashes as themselves. An ' +
          'escaped quote arrives as a literal \\" and reads as noise.',
      },
      notify: {
        type: 'boolean',
        description:
          'True to interrupt the caller to look at this now. Default false, which is right ' +
          'for anything that can wait for your final answer.',
        optional: true,
      },
    },
  },
  {
    name: 'report',
    description:
      'Post an interim finding to the caller while you keep working. Use it per batch of ' +
      'files rather than saving everything for the end: a report already delivered survives ' +
      'a final answer that is lost or cut short. Set notify only when what you found should ' +
      'change what the caller is doing right now — a mis-scoped task, a blocker, a wrong ' +
      'assumption in your instructions — because it interrupts them to read it; leave it off ' +
      'for routine progress, which is collected with your answer. Your final answer must still ' +
      'stand on its own; never replace it with "see my reports".',
    input: {
      finding: {
        type: 'string',
        description: 'What you found, concretely, citing locations as path:line.',
      },
      notify: {
        type: 'boolean',
        description: 'True to interrupt the caller now. Default false.',
        optional: true,
      },
    },
  },
];

/**
 * Spawn the worker (idempotent server-side) and attach to its stream.
 *
 * Safe to call before every task: spawning an id that already lives hands back
 * the live one with its memory intact, which is also what makes an iframe
 * reload cheap. The likely failure is the `subagents` grant being absent —
 * reported in the transcript rather than thrown past it.
 */
async function ensureWorker(): Promise<void> {
  if (stopStream) return;
  if (spawning) return spawning;
  spawning = (async () => {
    setWorkerStatus('spawning');
    const raw = await invoke('yaar://apps/self/agents', {
      action: 'spawn',
      personaId: WORKER_ID,
      systemPrompt: WORKER_PROMPT,
      tools: WORKER_TOOLS,
      model: 'sonnet',
    });
    const handle = z.safeParse(PersonaHandleSchema, raw);
    if (!handle.success) throw new Error('spawn returned an unexpected shape');
    const stop = await stream(handle.data.streamUri, onFrame, {
      kinds: ['start', 'text', 'thinking', 'done', 'error'],
    });
    stopStream = stop;
    setWorkerStatus('idle');
  })();
  try {
    await spawning;
  } catch (err) {
    setWorkerStatus('error');
    throw err;
  } finally {
    spawning = null;
  }
}

/**
 * What starting a task reports: the id to collect by, or why nothing started.
 * Exactly one field is ever set — but written as one optional-field shape rather
 * than a discriminated union, because app sources typecheck with `strict: false`,
 * where a union narrows on nothing and every read is an error.
 */
export interface StartOutcome {
  taskId?: number;
  error?: string;
}

/**
 * Hand the worker one task and return as soon as it is *accepted* — not when it
 * is answered.
 *
 * The awaits here are the two short ones: spawning the worker (so a missing
 * `subagents` grant is reported at the call that caused it, not three frames
 * into a subscription) and queuing the turn. The long wait — the worker
 * actually working — is nobody's await: the stream folds frames into the panel
 * as they arrive, and the terminal frame (or the watchdog) settles the record.
 * That is what lets the app agent start a survey, spend its next turns editing
 * or compiling, and collect the answer afterwards with `waitForWorker`.
 *
 * One turn at a time — a task sent while one is in flight is refused rather
 * than queued, and the server's own busy refusal backs that up.
 *
 * Two callers, one function: the panel's Run button and the app agent's
 * `workerTask` command. Both land every task and answer in the same transcript
 * signals, which is what keeps the panel a faithful window on agent-driven work.
 * They differ in exactly one thing, `opts.wakeAgent`: the agent's own task wakes
 * it when the answer lands, the user's does not (see `settle`).
 */
export async function startWorkerTask(
  task: string,
  opts: { wakeAgent?: boolean; fresh?: boolean } = {},
): Promise<StartOutcome> {
  const content = task.trim();
  if (!content) return { error: 'Empty task.' };
  if (inflight) {
    return {
      error:
        `The worker is already on task #${inflight.record.id}. Collect that one first ` +
        '(workerWait, or the "worker" state key), or stop it with workerInterrupt — ' +
        'tasks are refused, not queued.',
    };
  }
  if (!activeProject()) {
    appendEntry('error', 'No active project. Open or create one first.');
    return { error: 'No active project. Open or create one first.' };
  }

  // After the in-flight guard, never before it: a fresh start retires the
  // worker, and doing that to a running task would destroy an answer the caller
  // asked for the moment before.
  if (opts.fresh) await resetWorker();

  try {
    await ensureWorker();
  } catch (err) {
    appendEntry('error', `Could not spawn the worker: ${errMsg(err)}`);
    return { error: `Could not spawn the worker: ${errMsg(err)}` };
  }

  // Feedback on earlier proposals is delivered here rather than pushed when it
  // was decided: the server takes a message only while a turn is running, and
  // an accept or a reject lands after the proposing turn has ended.
  const owed = pendingFeedback;
  pendingFeedback = [];
  const message = owed.length
    ? `Since your last turn:\n${owed.map((line) => `- ${line}`).join('\n')}\n\nNow: ${content}`
    : content;

  const record: WorkerTaskRecord = {
    id: ++taskSeq,
    task: content,
    startedAt: Date.now(),
    ...(opts.wakeAgent ? { wakeAgent: true } : {}),
  };
  batch(() => {
    appendEntry('task', content);
    setWorkerActiveTask(record);
    setWorkerStatus('running');
    setWorkerDraft('');
    setWorkerThinking('');
  });
  inflight = { record, timer: setTimeout(() => {}, 0), waiters: [] };
  keepAlive();

  try {
    await invoke(`yaar://apps/self/agents/${WORKER_ID}`, { action: 'message', content: message });
  } catch (err) {
    // A turn that already settled is not this call's to fail: a fast worker can
    // finish before `message` resolves, and reporting the queue error then would
    // discard a real answer.
    if (inflight?.record.id !== record.id) return { taskId: record.id };
    batch(() => {
      appendEntry('error', errMsg(err));
      setWorkerStatus('idle');
    });
    settle({ error: errMsg(err) });
    return { error: errMsg(err) };
  }

  return { taskId: record.id };
}

/** Longest one `workerWait` may block, kept under the app-command ceiling (180s). */
const MAX_WAIT_MS = 170_000;
/** What `workerWait` waits when the caller names no bound. */
export const DEFAULT_WAIT_MS = 60_000;

/**
 * The answer to "is task #N done, and what did it say" — `done: false` when it
 * is still running, which is a report, not a failure.
 */
export interface WaitResult {
  done: boolean;
  taskId: number | null;
  status: WorkerStatus;
  elapsedMs: number | null;
  answer?: string;
  error?: string;
  /** Interim findings the worker posted while it worked, oldest first. */
  reports?: string[];
  /** Edits the worker proposed, as summaries — read one whole with readEditRequest. */
  proposals?: EditProposalSummary[];
}

/** Project a settled record into the wait result shape. */
function resultOf(record: WorkerTaskRecord): WaitResult {
  return {
    done: true,
    taskId: record.id,
    status: workerStatus(),
    elapsedMs: (record.endedAt ?? Date.now()) - record.startedAt,
    ...(record.answer ? { answer: record.answer } : {}),
    // A settled record always carries one of the two (see `settle`); the
    // fallback is for the record that somehow reached here without going
    // through it, and exists so this projection can never be the thing that
    // turns a failure into a silent success.
    ...(record.error || record.answer ? {} : { error: noAnswerError(record.reports ?? []) }),
    ...(record.error ? { error: record.error } : {}),
    ...(record.reports?.length ? { reports: record.reports } : {}),
    ...(record.proposals?.length ? { proposals: record.proposals } : {}),
  };
}

/**
 * Collect a backgrounded task: resolve now if it has already settled, otherwise
 * block until it does or until `waitMs` runs out.
 *
 * Timing out is deliberately cheap and repeatable — the task keeps running, the
 * record keeps its id, and calling again picks the same wait back up. That is
 * the property that makes a long survey safe to collect in bounded slices
 * instead of one call the caller's own deadline may kill.
 *
 * With no `taskId` it answers about the task in flight, or about the last one to
 * settle if the worker is idle.
 */
export function waitForWorker(
  opts: { taskId?: number; waitMs?: number } = {},
): Promise<WaitResult> {
  const waitMs = Math.max(1_000, Math.min(opts.waitMs ?? DEFAULT_WAIT_MS, MAX_WAIT_MS));
  const wanted = opts.taskId;
  const last = workerLastResult();

  if (wanted !== undefined && (!inflight || inflight.record.id !== wanted)) {
    if (last && last.id === wanted) return Promise.resolve(resultOf(last));
    // Waiting on an id nothing holds would block for the full waitMs and then
    // report "still running" about a task that is not — say so instead.
    return Promise.resolve({
      done: true,
      taskId: wanted,
      status: workerStatus(),
      elapsedMs: null,
      error:
        `No record of task #${wanted}. Only the task in flight and the last one to finish ` +
        'are kept — read the transcript in the "worker" state key for anything older.',
    });
  }

  if (!inflight) {
    if (last) return Promise.resolve(resultOf(last));
    return Promise.resolve({
      done: true,
      taskId: null,
      status: workerStatus(),
      elapsedMs: null,
      error: 'The worker has not run a task yet.',
    });
  }

  const { record, waiters } = inflight;
  return new Promise<WaitResult>((resolve) => {
    let answered = false;
    const timer = setTimeout(() => {
      if (answered) return;
      answered = true;
      resolve({
        done: false,
        taskId: record.id,
        status: workerStatus(),
        elapsedMs: Date.now() - record.startedAt,
        // Reports so far ride along on a timeout too — that is the point of
        // them. A caller whose wait expired gets what the worker has found up
        // to now instead of only "still running", and can decide from it
        // whether to keep waiting or interrupt.
        ...(record.reports?.length ? { reports: [...record.reports] } : {}),
        ...(proposalsOfTask(record.id).length ? { proposals: proposalsOfTask(record.id) } : {}),
      });
    }, waitMs);
    waiters.push((outcome) => {
      // Already reported "still running" — this caller has moved on, and saying
      // so is what lets `settle` know a wakeup is still owed.
      if (answered) return false;
      answered = true;
      clearTimeout(timer);
      resolve({
        done: true,
        taskId: record.id,
        status: workerStatus(),
        elapsedMs: Date.now() - record.startedAt,
        ...(outcome.answer ? { answer: outcome.answer } : {}),
        ...(outcome.error ? { error: outcome.error } : {}),
        ...(outcome.reports?.length ? { reports: outcome.reports } : {}),
        ...(outcome.proposals?.length ? { proposals: outcome.proposals } : {}),
      });
      return true;
    });
  });
}

/**
 * Stop the turn in flight, and hand back everything it managed to produce — the
 * partial draft plus any reports.
 *
 * Returns a result rather than void because interrupting is now something the
 * app agent does (`workerInterrupt`), and the whole reason to interrupt a
 * mis-scoped task is that the partial work is still worth reading. A caller
 * that only wants the click, like the panel, ignores the return.
 */
export async function interruptWorker(): Promise<WaitResult> {
  const stopped = inflight?.record;
  try {
    await invoke(`yaar://apps/self/agents/${WORKER_ID}`, { action: 'interrupt' });
  } catch {
    /* not spawned or already idle — nothing to stop */
  }
  const draft = workerDraft().trim();
  batch(() => {
    if (draft) appendEntry('answer', `${draft}\n(interrupted)`);
    else appendEntry('error', 'Interrupted.');
    setWorkerDraft('');
    setWorkerStatus('idle');
  });
  settle({ error: 'Interrupted.', ...(draft ? { answer: draft } : {}) });

  // Read back through `workerLastResult` rather than from the outcome above:
  // the turn may have settled on its own between the invoke and here, and the
  // answer it settled with is better than the one we were about to force.
  const last = workerLastResult();
  if (last && (!stopped || last.id === stopped.id)) return resultOf(last);
  return {
    done: true,
    taskId: stopped?.id ?? null,
    status: workerStatus(),
    elapsedMs: null,
    error: 'Nothing was running.',
  };
}

/**
 * Retire the worker and clear the transcript. The next task spawns a fresh
 * session with none of this one's memory — the escape hatch for a worker whose
 * context has gone stale or heavy.
 */
export async function resetWorker(): Promise<void> {
  settle({ error: 'The worker was reset.' });
  stopStream?.();
  stopStream = null;
  await del(`yaar://apps/self/agents/${WORKER_ID}`).catch(() => {});
  batch(() => {
    setWorkerEntries([]);
    setWorkerDraft('');
    setWorkerThinking('');
    setWorkerStatus('offline');
    // Proposals go with the transcript too: their rationale is a turn of a
    // conversation that no longer exists, and accepting one on the strength of a
    // summary alone is the reading this feature exists to prevent.
    setWorkerProposals([]);
    pendingFeedback = [];
    // The last result goes with the transcript it belonged to. Keeping it would
    // hand the next `workerWait` an answer from a conversation that no longer
    // exists — the one reading a reset worker is least equipped to catch.
    setWorkerLastResult(null);
  });
}
