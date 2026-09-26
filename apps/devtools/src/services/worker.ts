export {};
import { createSignal, batch, type Accessor, type Setter } from '@bundled/solid-js';
import { throttle } from '@bundled/lodash';
import {
  app,
  appStorage,
  createSharedSignal,
  invoke,
  read,
  del,
  stream,
  errMsg,
  type StreamFrame,
} from '@bundled/yaar';
import * as z from '@bundled/zod';
import { activeProject, files } from '../core';
import { applyEdits, type EditSpec } from '../lib/edits';
import { filesNamedInTask } from '../lib/source-scan';
import { PersonaHandleSchema, WorkerEditListSchema, WorkerFrameDataSchema } from '../schema';
import { readFileText } from './files';

// The worker sub-agents — sonnet-tier explorers devtools spawns for itself via
// `yaar://apps/self/agents` (requires the user-granted `subagents` capability in
// app.json). A worker holds NO YAAR verbs and no filesystem: its only reach is
// the five tools declared at spawn, each of which the server routes back to this
// iframe as a `persona:{name}` command stamped with the calling `personaId`
// (handlers: protocol/worker.ts). Containment, not plumbing — a worker can never
// see more of the machine than devtools itself shows it.
//
// A small pool, not one worker: up to MAX_WORKERS slots with fixed persona ids,
// of which `workerCap()` may run at once. Each slot is its own persistent session,
// so a follow-up goes to the slot that ran the previous task (see `pickSlot`), and
// `fresh` retires only the slot it lands on.
//
// Concurrency is safe because workers never write. Their only route to a change
// is `edit_request`, which dry-runs and parks a proposal; `acceptEditRequest` is
// the single writer and runs accepts one at a time. Two proposals against the same
// file are flagged `conflictsWith` each other at submission, and the second accept
// re-checks against the file the first one left.

/** Hard ceiling — must not exceed `subagents.max` in app.json. */
export const MAX_WORKERS = 3;
export const DEFAULT_WORKER_CAP = 2;
const WORKER_IDS = ['worker', 'worker-2', 'worker-3'] as const;
const CONFIG_PATH = 'worker-config.json';

/**
 * How long a turn may go without any sign of life before we give up on it.
 * "Life" is any stream frame OR any tool-handler invocation — a worker deep in a
 * grep loop produces no text frames, so the tool handlers call `noteWorkerToolCall`
 * to keep the watchdog fed.
 */
const TURN_IDLE_TIMEOUT_MS = 180_000;

export type WorkerStatus = 'offline' | 'spawning' | 'idle' | 'running' | 'error';

export interface WorkerEntry {
  kind: 'task' | 'answer' | 'tool' | 'report' | 'edit-request' | 'error';
  text: string;
  timestamp: number;
  /** The slot id that produced this line. */
  worker: string;
}

/**
 * How one task ended. `answer` may accompany `error` — the partial draft of a
 * turn that went quiet or was interrupted is worth more than the error alone.
 */
export interface TurnOutcome {
  answer?: string;
  error?: string;
  reports?: string[];
  proposals?: EditProposalSummary[];
  /** Every file the worker opened with read_file this task. */
  filesRead?: string[];
  /** Files the task named that the worker never opened. */
  filesNotRead?: string[];
  /** Why a turn that ended without a terminal frame probably stopped. */
  stopDiagnosis?: StopDiagnosis;
}

/**
 * The server does not say why a turn stopped without a `done` or `error` frame, so
 * this is what the turn's own activity suggests.
 */
export interface StopDiagnosis {
  likelyCause: string;
  silentForMs: number;
  toolCalls: number;
  /** Characters of tool output (file reads and grep results) the worker took in. */
  charsRead: number;
  lastTool?: string;
}

/** One grep the worker ran, kept as evidence for the proposals that follow it. */
export interface GrepEvidence {
  pattern: string;
  glob?: string;
  matches: number;
  /** Up to a few `path:line│text` lines, preferring the proposal's own file. */
  sample: string[];
}

/** One task, from acceptance to outcome. Ids are global across slots. */
export interface WorkerTaskRecord {
  id: number;
  task: string;
  /** The slot id running it. */
  worker: string;
  startedAt: number;
  endedAt?: number;
  answer?: string;
  error?: string;
  /**
   * Interim findings, oldest first. Mutated in place by {@link addWorkerReport}:
   * this record is the one the slot's `inflight` holds and the one `settle`
   * spreads, and nothing renders it reactively.
   */
  reports?: string[];
  proposals?: EditProposalSummary[];
  /**
   * Whether the app agent started this one, and so should be woken when it
   * settles. False for a task the user ran from the Worker panel.
   */
  wakeAgent?: boolean;
  /** Files the task text names (paths, directories, globs), resolved at start. */
  scope?: string[];
  filesRead?: string[];
  filesNotRead?: string[];
  stopDiagnosis?: StopDiagnosis;
  // Activity bookkeeping, mutated in place like `reports`.
  charsRead?: number;
  toolCalls?: number;
  lastTool?: string;
  lastActivityAt?: number;
  /** Where the next read-budget nudge fires, in chars read. */
  nudgeAt?: number;
}

interface Inflight {
  record: WorkerTaskRecord;
  timer: ReturnType<typeof setTimeout>;
  /** Returns whether it actually delivered — a waiter whose own wait already
   * timed out returns false, which is what keeps the wakeup honest. */
  waiters: Array<(outcome: TurnOutcome) => boolean>;
}

/**
 * One worker. Signals for what the panel renders; plain fields for bookkeeping
 * nothing renders. Slots are created once at module scope and never replaced.
 */
export interface WorkerSlot {
  id: string;
  /** Short panel label: W1, W2, W3. */
  label: string;
  status: Accessor<WorkerStatus>;
  setStatus: Setter<WorkerStatus>;
  /** Accumulated text deltas of the turn in flight. */
  draft: Accessor<string>;
  setDraft: Setter<string>;
  thinking: Accessor<string>;
  setThinking: Setter<string>;
  activeTask: Accessor<WorkerTaskRecord | null>;
  setActiveTask: Setter<WorkerTaskRecord | null>;
  inflight: Inflight | null;
  /** Held between choosing this slot and its turn being in flight, so two starts
   * racing through the spawn await cannot pick the same slot. */
  reserved: boolean;
  stopStream: (() => void) | null;
  spawning: Promise<void> | null;
  /**
   * Feedback owed to this worker on its earlier proposals, delivered at the head
   * of its next task — the server takes no message while no turn is running.
   */
  pendingFeedback: string[];
  /** Draw what another copy of this window reports for this slot. */
  adopt: (view: SlotView) => void;
}

// Sharing the panel across copies of this window. The workers belong to whichever
// copy started them: its stream feeds their drafts and its commands settle their
// tasks. The agent's commands run in the copy the server picked, which on a phone is
// the companion tab's, so the copy on screen showed an empty Worker panel while
// three workers ran.
//
// What is shared is what the panel draws, as one snapshot, written by the copy
// doing the work. Throttled rather than written per frame: a draft grows by a
// token at a time, and each write resends the whole snapshot, so another copy sees
// a live draft that advances twice a second. The bookkeeping behind the commands —
// in-flight records, waiters, proposals, settled results — is not shared: only the
// copy that owns the workers can act on it.

/** What one slot looks like on the panel. */
export interface SlotView {
  id: string;
  status: WorkerStatus;
  draft: string;
  thinking: string;
  task: WorkerTaskRecord | null;
}

interface WorkerView {
  cap: number;
  entries: WorkerEntry[];
  slots: SlotView[];
}

const SHARE_INTERVAL_MS = 500;
/** The transcript has no cap of its own; the shared copy of it does. */
const MAX_SHARED_ENTRIES = 200;

const [, setSharedView, sharedViewReady] = createSharedSignal<WorkerView | null>('worker', null, {
  onRemote: (view) => adoptView(view),
});

// Deferred a microtask so a batch of setters is read once it has landed.
const publishView = throttle(
  () => queueMicrotask(() => setSharedView(currentView())),
  SHARE_INTERVAL_MS,
);

/**
 * A setter that also schedules the snapshot. Only the mutation sites hold these;
 * adopting a remote snapshot goes through the raw setters, so a copy that follows
 * never writes back what it was just sent.
 */
function published<T>(set: Setter<T>): Setter<T> {
  return ((...args: unknown[]) => {
    const out = (set as (...a: unknown[]) => unknown)(...args);
    publishView();
    return out;
  }) as Setter<T>;
}

function makeSlot(id: string, index: number): WorkerSlot {
  const [status, setStatus] = createSignal<WorkerStatus>('offline');
  const [draft, setDraft] = createSignal('');
  const [thinking, setThinking] = createSignal('');
  const [activeTask, setActiveTask] = createSignal<WorkerTaskRecord | null>(null);
  const slot: WorkerSlot = {
    id,
    label: `W${index + 1}`,
    status,
    setStatus: published(setStatus),
    draft,
    setDraft: published(setDraft),
    thinking,
    setThinking: published(setThinking),
    activeTask,
    setActiveTask: published(setActiveTask),
    inflight: null,
    reserved: false,
    stopStream: null,
    spawning: null,
    pendingFeedback: [],
    adopt: (view) => {
      // Another copy retired this worker (its Reset). A stream still attached here
      // points at a session that no longer exists, and would stop the next task
      // from spawning a new one — `ensureWorker` keys on it.
      if (view.status === 'offline' && slot.stopStream) {
        slot.stopStream();
        slot.stopStream = null;
      }
      batch(() => {
        setStatus(view.status);
        setDraft(view.draft);
        setThinking(view.thinking);
        setActiveTask(view.task);
      });
    },
  };
  return slot;
}

export const workerSlots: WorkerSlot[] = WORKER_IDS.map(makeSlot);

export const [workerCap, setWorkerCapSignal] = createSignal(DEFAULT_WORKER_CAP);
const [workerEntries, setWorkerEntriesRaw] = createSignal<WorkerEntry[]>([]);
export { workerEntries };
export const setWorkerEntries = published(setWorkerEntriesRaw);

function currentView(): WorkerView {
  return {
    cap: workerCap(),
    entries: workerEntries().slice(-MAX_SHARED_ENTRIES),
    slots: workerSlots.map((s) => ({
      id: s.id,
      status: s.status(),
      draft: s.draft(),
      thinking: s.thinking(),
      task: s.activeTask(),
    })),
  };
}

function adoptView(view: WorkerView | null): void {
  if (!view || !Array.isArray(view.entries) || !Array.isArray(view.slots)) return;
  // A copy with workers of its own keeps drawing those; two copies each running
  // tasks is a case the snapshot cannot merge, and its own are the ones it can act on.
  if (workerSlots.some((s) => s.inflight || s.reserved || s.spawning)) return;
  batch(() => {
    if (typeof view.cap === 'number') setWorkerCapSignal(clampCap(view.cap));
    setWorkerEntriesRaw(view.entries);
    for (const v of view.slots) slotById(v.id)?.adopt(v);
  });
}

// A copy that mounts while another is working gets the snapshot here — `onRemote`
// does not run for the initial load.
void sharedViewReady.then((view) => adoptView(view));

/**
 * The most recently settled task. Older settled records stay reachable by id
 * through `settledTasks` so a caller fanning out several tasks can collect each.
 */
export const [workerLastResult, setWorkerLastResult] = createSignal<WorkerTaskRecord | null>(null);

const MAX_SETTLED = 30;
const settledTasks = new Map<number, WorkerTaskRecord>();
/** The slot that settled most recently — where a follow-up task goes. */
let lastSlotId: string | null = null;
let taskSeq = 0;

/** The pool's overall status, for the sidebar dot: running beats error beats idle. */
export function workerStatus(): WorkerStatus {
  const all = workerSlots.map((s) => s.status());
  if (all.includes('running')) return 'running';
  if (all.includes('spawning')) return 'spawning';
  if (all.includes('error')) return 'error';
  if (all.includes('idle')) return 'idle';
  return 'offline';
}

/** Every task in flight, oldest first. */
export function workerActiveTasks(): WorkerTaskRecord[] {
  return workerSlots
    .map((s) => s.activeTask())
    .filter((t): t is WorkerTaskRecord => t !== null)
    .sort((a, b) => a.id - b.id);
}

function slotById(id: string | undefined): WorkerSlot | undefined {
  return workerSlots.find((s) => s.id === id);
}

/** The slot a persona tool call came from; the first slot for an unknown id. */
function slotOf(personaId: string | undefined): WorkerSlot {
  return slotById(personaId) ?? workerSlots[0];
}

function isBusy(slot: WorkerSlot): boolean {
  return slot.reserved || slot.inflight !== null;
}

/** Workers within the cap that could take a task right now. */
export function freeWorkerCount(): number {
  return workerSlots.slice(0, workerCap()).filter((s) => !isBusy(s)).length;
}

function appendEntry(slot: WorkerSlot, kind: WorkerEntry['kind'], text: string): void {
  setWorkerEntries([...workerEntries(), { kind, text, timestamp: Date.now(), worker: slot.id }]);
}

/**
 * Load the persisted concurrency cap. Absent or unreadable keeps the default. Runs on
 * every mount, so it does not publish: a copy mounting late would otherwise send its
 * empty panel over the one another copy is drawing.
 */
export async function loadWorkerConfig(): Promise<void> {
  try {
    const raw = await appStorage.readJsonOr<{ maxWorkers?: unknown }>(CONFIG_PATH, {});
    if (typeof raw?.maxWorkers === 'number') setWorkerCapSignal(clampCap(raw.maxWorkers));
  } catch {
    /* keep the default */
  }
}

function clampCap(n: number): number {
  return Math.max(1, Math.min(MAX_WORKERS, Math.round(n)));
}

/** Set and persist how many workers may run at once. Running tasks are never stopped. */
export async function setWorkerCap(n: number): Promise<number> {
  const cap = clampCap(n);
  setWorkerCapSignal(cap);
  publishView();
  await appStorage.save(CONFIG_PATH, JSON.stringify({ maxWorkers: cap }, null, 2));
  return cap;
}

/**
 * Why a task that produced no answer is an *error* and never a quiet success:
 * a survey is often a search for negative results, so a settled task carrying
 * neither `answer` nor `error` is indistinguishable from "nothing found".
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

/** Settle a slot's turn once, whatever ended it, and stop its watchdog. */
function settle(slot: WorkerSlot, outcome: TurnOutcome): void {
  const inflight = slot.inflight;
  if (!inflight) return;
  clearTimeout(inflight.timer);
  const { record, waiters } = inflight;
  slot.inflight = null;
  const reports = record.reports ?? [];
  const answer = outcome.answer?.trim() || undefined;
  // The invariant every reader depends on: a settled task reports *something*.
  const error = outcome.error ?? (answer ? undefined : noAnswerError(reports));
  const proposals = proposalsOfTask(record.id);
  const filesRead = record.filesRead ?? [];
  const filesNotRead = (record.scope ?? []).filter((p) => !filesRead.includes(p));
  const settled: TurnOutcome = {
    ...(answer ? { answer } : {}),
    ...(error ? { error } : {}),
    ...(reports.length ? { reports } : {}),
    ...(proposals.length ? { proposals } : {}),
    ...(filesRead.length ? { filesRead } : {}),
    ...(filesNotRead.length ? { filesNotRead } : {}),
    ...(outcome.stopDiagnosis ? { stopDiagnosis: outcome.stopDiagnosis } : {}),
  };
  const finished: WorkerTaskRecord = { ...record, endedAt: Date.now(), ...settled };
  settledTasks.set(finished.id, finished);
  if (settledTasks.size > MAX_SETTLED) settledTasks.delete(settledTasks.keys().next().value!);
  lastSlotId = slot.id;
  batch(() => {
    slot.setActiveTask(null);
    setWorkerLastResult(finished);
  });
  let served = false;
  for (const resolve of waiters) served = resolve(settled) || served;

  // The event always goes out; the wakeup only when the agent started this task
  // and no `workerWait` of its own was handed the answer already.
  app?.emit(
    'worker',
    {
      kind: 'result',
      taskId: finished.id,
      worker: slot.id,
      task: finished.task,
      ...(finished.answer ? { answer: finished.answer } : {}),
      ...(finished.error ? { error: finished.error } : {}),
      ...(reports.length ? { reports } : {}),
      ...(proposals.length ? { proposals } : {}),
      ...(filesNotRead.length ? { filesNotRead } : {}),
      ...(settled.stopDiagnosis ? { stopDiagnosis: settled.stopDiagnosis } : {}),
      ...(finished.answer && finished.answer.length > LONG_ANSWER_CHARS
        ? {
            answerChars: finished.answer.length,
            answerNote:
              `The answer is ${finished.answer.length} chars; if it arrives cut short, ` +
              `workerWait({ taskId: ${finished.id} }) returns it whole.`,
          }
        : {}),
      elapsedMs: (finished.endedAt ?? Date.now()) - finished.startedAt,
    },
    { wakeAgent: !!finished.wakeAgent && !served },
  );
}

/** Answers longer than this carry a pointer to workerWait in the wakeup event. */
const LONG_ANSWER_CHARS = 6000;

/** Tool output a worker may take in before it is told to report and wrap up. */
const READ_NUDGE_CHARS = 120_000;
const READ_NUDGE_STEP = 60_000;

function diagnoseQuiet(record: WorkerTaskRecord): StopDiagnosis {
  const charsRead = record.charsRead ?? 0;
  const toolCalls = record.toolCalls ?? 0;
  const likelyCause =
    charsRead > 200_000
      ? `context exhaustion is likely: the worker took in ~${Math.round(charsRead / 1000)}K chars of tool output this turn`
      : toolCalls >= 60
        ? `a turn or tool-call limit is likely: ${toolCalls} tool calls this turn`
        : 'unknown: the server ended the turn without a done or error frame and did not say why';
  return {
    likelyCause,
    silentForMs: Date.now() - (record.lastActivityAt ?? record.startedAt),
    toolCalls,
    charsRead,
    ...(record.lastTool ? { lastTool: record.lastTool } : {}),
  };
}

/** Restart a slot's silence watchdog — any frame or tool call counts as progress. */
function keepAlive(slot: WorkerSlot): void {
  const inflight = slot.inflight;
  if (!inflight) return;
  clearTimeout(inflight.timer);
  inflight.record.lastActivityAt = Date.now();
  inflight.timer = setTimeout(() => {
    const draft = slot.draft().trim();
    const diagnosis = diagnoseQuiet(inflight.record);
    batch(() => {
      appendEntry(
        slot,
        'error',
        `Worker went quiet (${diagnosis.likelyCause})${draft ? ` — partial answer kept:\n${draft}` : ''}.`,
      );
      slot.setDraft('');
      slot.setStatus('idle');
    });
    settle(slot, {
      error:
        'The worker went quiet: no frame or tool call for ' +
        `${Math.round(TURN_IDLE_TIMEOUT_MS / 1000)}s. Likely cause: ${diagnosis.likelyCause}. ` +
        '`filesRead`/`filesNotRead` say what it covered; re-run only what it did not, in smaller slices.',
      stopDiagnosis: diagnosis,
      ...(draft ? { answer: draft } : {}),
    });
  }, TURN_IDLE_TIMEOUT_MS);
}

/**
 * Tool handlers report in here (protocol/worker.ts): the transcript line for a
 * tool call, and the watchdog's sign of life for the slot that made it.
 */
export function noteWorkerToolCall(summary: string, personaId?: string): void {
  const slot = slotOf(personaId);
  appendEntry(slot, 'tool', summary);
  const record = slot.inflight?.record;
  if (record) {
    record.toolCalls = (record.toolCalls ?? 0) + 1;
    record.lastTool = summary;
  }
  keepAlive(slot);
}

/**
 * Count one read_file result against the task. Returns a note to append to what the
 * worker reads when its intake crosses the next budget line, or '' — the nudge is
 * what gets findings reported before a turn runs out of context and dies silently.
 */
export function noteWorkerRead(personaId: string, path: string, chars: number): string {
  const record = slotOf(personaId).inflight?.record;
  if (!record) return '';
  const read = (record.filesRead ??= []);
  const clean = path.replace(/^\.\//, '');
  if (!read.includes(clean)) read.push(clean);
  return countIntake(record, chars);
}

/** Record one grep as evidence, and count its output against the read budget. */
export function noteWorkerGrep(
  personaId: string,
  pattern: string,
  glob: string | undefined,
  lines: string[],
): string {
  const record = slotOf(personaId).inflight?.record;
  if (!record) return '';
  // Kept off the record: records ride in the shared panel snapshot, twice a second.
  const greps = taskGreps.get(record.id) ?? [];
  greps.push({
    pattern,
    ...(glob ? { glob } : {}),
    matches: lines.length,
    sample: lines.slice(0, 30),
  });
  if (greps.length > 10) greps.shift();
  taskGreps.set(record.id, greps);
  if (taskGreps.size > MAX_SETTLED) taskGreps.delete(taskGreps.keys().next().value!);
  return countIntake(
    record,
    lines.reduce((n, l) => n + l.length + 1, 0),
  );
}

const taskGreps = new Map<number, GrepEvidence[]>();

function countIntake(record: WorkerTaskRecord, chars: number): string {
  record.charsRead = (record.charsRead ?? 0) + chars;
  const at = record.nudgeAt ?? READ_NUDGE_CHARS;
  if (record.charsRead < at) return '';
  record.nudgeAt = record.charsRead + READ_NUDGE_STEP;
  const unread = (record.scope ?? []).filter((p) => !(record.filesRead ?? []).includes(p));
  return (
    `\n\n[Dev Tools: you have taken in ~${Math.round(record.charsRead / 1000)}K chars this task and ` +
    'your context is filling. Post what you have found so far with the report tool now. Then ' +
    'finish only the most important remaining files and give your final answer, naming every ' +
    `file you did not get to${unread.length ? ` (${unread.length} of the files the task named are still unread)` : ''}.]`
  );
}

/** The evidence a proposal carries: this task's greps, samples narrowed to its file first. */
function evidenceFor(record: WorkerTaskRecord | undefined, path: string): GrepEvidence[] {
  return (record ? (taskGreps.get(record.id) ?? []) : []).slice(-8).map((g) => {
    const own = g.sample.filter((l) => l.startsWith(path + ':'));
    const rest = g.sample.filter((l) => !l.startsWith(path + ':'));
    return { ...g, sample: [...own, ...rest].slice(0, 6) };
  });
}

/**
 * Take one interim finding from a worker, mid-turn.
 *
 * `report` is an app-declared tool like `grep`, so it arrives over the same
 * bridge and its only reach is this function. It buys partial results that
 * survive a lost answer, early course correction, and legible progress. `notify`
 * wakes the app agent; routine progress is collected with the result. A report on
 * a task the *user* started never wakes anyone.
 */
export function addWorkerReport(finding: string, notify = false, personaId?: string): string {
  const slot = slotOf(personaId);
  const text = finding.trim();
  if (!text) return 'Empty report — nothing recorded. Say what you found, or say nothing.';
  if (!slot.inflight) {
    appendEntry(slot, 'report', text);
    return 'Recorded, but no task is in flight — nobody is waiting on this.';
  }

  const { record } = slot.inflight;
  const reports = (record.reports ??= []);
  reports.push(text);
  appendEntry(slot, 'report', text);
  keepAlive(slot);

  const wakeAgent = !!record.wakeAgent && notify;
  app?.emit(
    'worker',
    {
      kind: 'report',
      taskId: record.id,
      worker: slot.id,
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
// A worker reads the project but cannot write to it. `edit_request` gives the
// edit it would make a shape: it is dry-run and parked, and `acceptEditRequest`
// (protocol/worker.ts) is the only writer. The dry run's answer lands in the
// worker's own turn, so a bad search string is fixed while it still has the file
// in context and only proposals that apply cleanly reach the main agent.

const MAX_PROPOSALS = 40;

/**
 * Refused as a string the worker can act on, not thrown: a missing project is a
 * normal state mid-conversation.
 */
export const NO_ACTIVE_PROJECT = 'No project is active in Dev Tools right now. Say so and stop.';

/** A change a worker proposes and cannot make. */
export interface EditProposal {
  id: number;
  /** The task it came out of, or null for one submitted with no turn in flight. */
  taskId: number | null;
  /** The slot id that proposed it — where its feedback is delivered. */
  worker: string;
  path: string;
  edits: EditSpec[];
  rationale: string;
  createdAt: number;
  status: 'pending' | 'accepted' | 'rejected' | 'failed';
  /**
   * The read gate: `readEditRequest` is the only command that serves this, and
   * `acceptEditRequest` refuses without it. A discipline gate, not a security
   * boundary.
   */
  token: string;
  resolution?: string;
  /** The greps the worker ran in this task before proposing — what it checked. */
  evidence?: GrepEvidence[];
}

/** What a list of proposals says without quoting their bodies. */
export interface EditProposalSummary {
  id: number;
  worker: string;
  path: string;
  edits: number;
  rationale: string;
  status: EditProposal['status'];
  /** Other pending proposals against the same file — accepting one may stale the rest. */
  conflictsWith?: number[];
}

export const [workerProposals, setWorkerProposals] = createSignal<EditProposal[]>([]);
let proposalSeq = 0;

/** FNV-1a over the proposal body. Short, stable, and not derivable from a summary. */
function proposalToken(path: string, rationale: string, edits: EditSpec[]): string {
  const source = `${path} ${rationale} ${JSON.stringify(edits)}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, '0');
}

/** Pending proposals other than `id` that target `path`. */
export function pendingOnPath(path: string, exceptId?: number): EditProposal[] {
  return workerProposals().filter(
    (p) => p.status === 'pending' && p.path === path && p.id !== exceptId,
  );
}

/**
 * A summary carries the rationale and never the edit bodies: `readEditRequest` is
 * where those live, and an accept is supposed to cost a deliberate read.
 */
export function summarizeProposal(p: EditProposal): EditProposalSummary {
  const rationale = p.rationale.length > 500 ? `${p.rationale.slice(0, 500)}…` : p.rationale;
  const conflicts = p.status === 'pending' ? pendingOnPath(p.path, p.id).map((q) => q.id) : [];
  return {
    id: p.id,
    worker: p.worker,
    path: p.path,
    edits: p.edits.length,
    rationale,
    status: p.status,
    ...(conflicts.length ? { conflictsWith: conflicts } : {}),
  };
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

/** Tell a worker how one of its proposals ended, at the start of its next task. */
export function queueWorkerFeedback(line: string, workerId?: string): void {
  slotOf(workerId).pendingFeedback.push(line);
}

export interface ProposalCheck {
  ok: boolean;
  error?: string;
  lines?: number;
}

/**
 * Apply the edits in memory and throw nothing away — run at submission (the
 * worker's correction loop) and at accept (the staleness check). `requireUnique`
 * is on: a search string that matches twice would splice into a guess.
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
 * An edit list as JSON delivered it — from a worker's tool call or a caller's amendment —
 * as `EditSpec`s, with the `oldString`/`newString` aliases folded in. Null when the shape
 * is wrong.
 */
export function parseEditSpecs(raw: unknown): EditSpec[] | null {
  const parsed = z.safeParse(WorkerEditListSchema, raw);
  if (!parsed.success) return null;
  return parsed.data.map((e) => ({
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
}

/**
 * Take one proposed edit from a worker, dry-run it, and park it for the caller.
 * Returns the string the worker reads as its tool result.
 */
export async function addWorkerEditRequest(input: {
  path: string;
  editsJson: string;
  rationale: string;
  notify?: boolean;
  personaId?: string;
}): Promise<string> {
  const slot = slotOf(input.personaId);
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
  const edits = parseEditSpecs(raw);
  if (!edits) {
    return 'edits must be an array of objects, each with search+replace or startLine+endLine+anchor.';
  }
  if (edits.length === 0) return 'edits is empty — nothing to propose.';

  const check = await validateProposedEdits(path, edits);
  if (!check.ok) {
    return `Not submitted — ${check.error} Re-read the file and try again; nothing was changed.`;
  }

  const rivals = pendingOnPath(path);
  const proposal: EditProposal = {
    id: ++proposalSeq,
    taskId: slot.inflight?.record.id ?? null,
    worker: slot.id,
    path,
    edits,
    rationale,
    createdAt: Date.now(),
    status: 'pending',
    token: proposalToken(path, rationale, edits),
  };
  const evidence = evidenceFor(slot.inflight?.record, path);
  if (evidence.length) proposal.evidence = evidence;
  setWorkerProposals([...workerProposals(), proposal].slice(-MAX_PROPOSALS));
  appendEntry(
    slot,
    'edit-request',
    `#${proposal.id} ${path} · ${edits.length} edit${edits.length === 1 ? '' : 's'}` +
      (rivals.length ? ` · conflicts with #${rivals.map((r) => r.id).join(', #')}` : '') +
      `\n${rationale}`,
  );
  keepAlive(slot);

  const wakeAgent = !!slot.inflight?.record.wakeAgent && input.notify === true;
  app?.emit(
    'worker',
    {
      kind: 'edit-request',
      taskId: proposal.taskId,
      worker: slot.id,
      proposal: summarizeProposal(proposal),
      elapsedMs: slot.inflight ? Date.now() - slot.inflight.record.startedAt : 0,
    },
    { wakeAgent },
  );

  const conflictNote = rivals.length
    ? ` Note: ${rivals.length} other pending proposal${rivals.length === 1 ? '' : 's'} ` +
      `(#${rivals.map((r) => r.id).join(', #')}) already target this file, possibly from ` +
      'another worker running in parallel; whichever is accepted second is re-checked and may ' +
      'no longer apply.'
    : '';
  return (
    `Edit request #${proposal.id} submitted and verified against ${path} — it applies cleanly ` +
    `(${check.lines} lines after). The caller decides whether to apply it; you cannot.` +
    conflictNote +
    ' Keep working, and still describe this change in your final answer.'
  );
}

function proposalsOfTask(taskId: number): EditProposalSummary[] {
  return workerProposals()
    .filter((p) => p.taskId === taskId)
    .map(summarizeProposal);
}

/** Fold one stream frame into a slot's state; settle its turn on a terminal. */
function onFrame(slot: WorkerSlot, frame: StreamFrame): void {
  const parsed = z.safeParse(WorkerFrameDataSchema, frame.data ?? {});
  if (!parsed.success) {
    console.warn('[devtools] unreadable worker frame', slot.id, frame.kind, frame.data);
    return;
  }
  const data = parsed.data;
  keepAlive(slot);

  switch (frame.kind) {
    case 'start':
      batch(() => {
        slot.setDraft('');
        slot.setThinking('');
        slot.setStatus('running');
      });
      break;
    case 'text':
      slot.setDraft(slot.draft() + (data.delta ?? ''));
      break;
    case 'thinking':
      slot.setThinking(slot.thinking() + (data.delta ?? ''));
      break;
    case 'done': {
      const text = (data.text ?? slot.draft()).trim();
      // Capped in transit: the answer exists and is too big for one frame — go
      // get it from the persona, which keeps the last turn's final text.
      if (!text && data.truncated) {
        batch(() => {
          slot.setDraft('');
          slot.setStatus('idle');
        });
        void settleFromPersonaRead(slot);
        break;
      }
      const shortfall = !text
        ? noAnswerError(slot.inflight?.record.reports ?? [])
        : data.status === 'interrupted'
          ? 'The turn was interrupted before the worker finished — the answer is partial.'
          : undefined;
      batch(() => {
        if (text) appendEntry(slot, 'answer', text);
        if (shortfall) appendEntry(slot, 'error', shortfall);
        slot.setDraft('');
        slot.setStatus('idle');
      });
      settle(slot, {
        ...(text ? { answer: text } : {}),
        ...(shortfall ? { error: shortfall } : {}),
      });
      break;
    }
    case 'error': {
      const message =
        data.error ??
        (data.truncated
          ? 'The worker’s turn failed with an error too large to fit one stream frame.'
          : 'stream error');
      batch(() => {
        appendEntry(slot, 'error', message);
        slot.setDraft('');
        slot.setStatus('idle');
      });
      settle(slot, { error: message });
      break;
    }
  }
}

/**
 * Recover an answer the `done` frame could not carry, and settle with it. Gated
 * on `truncated`: a capped frame is proof the turn produced text, so the
 * persona's `lastResponse` cannot be a stale one.
 */
async function settleFromPersonaRead(slot: WorkerSlot): Promise<void> {
  let answer = '';
  let failure = '';
  try {
    const raw = await read(`yaar://apps/self/agents/${slot.id}`);
    const parsed = z.safeParse(PersonaHandleSchema, raw);
    if (!parsed.success) failure = 'reading the worker back returned an unexpected shape';
    else answer = (parsed.data.lastResponse ?? '').trim();
  } catch (err) {
    failure = errMsg(err);
  }

  if (answer) {
    appendEntry(slot, 'answer', answer);
    settle(slot, { answer });
    return;
  }
  const shortfall =
    'The worker finished with an answer too large for one stream frame, and recovering it ' +
    `from the worker itself ${failure ? `failed (${failure})` : 'came back empty'}. The turn ` +
    'is NOT "nothing found" — re-run it in smaller slices, and tell the worker to report as ' +
    'it goes so the findings arrive before the answer does.';
  appendEntry(slot, 'error', shortfall);
  settle(slot, { error: shortfall });
}

/**
 * The worker's constitution, used verbatim as its whole system prompt.
 * Project-agnostic: the prompt is fixed for the persona's lifetime, but the active
 * project can change between tasks.
 */
const WORKER_PROMPT = `You are a Dev Tools worker: a fast, subordinate explorer inside YAAR's Dev Tools IDE.
Each message is one task about the currently active app project — a small web app built from
TypeScript/Solid.js sources, an app.json manifest, and assets. Other workers may be running other
tasks on the same project at the same time; stay inside the task you were given.

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
turn. If it tells you another proposal already targets the same file, keep your edit minimal and
say in the rationale what it depends on. Still describe the change in your final answer: the
caller decides from that.

Text you propose for a comment or a doc is read later by someone who never saw this task. Never
put work notes in it: no "(verified by grep)", "per the task", "fixed:", "now" or "no longer".
State what the code does or requires, not how you checked it. Check every sentence you write
against the code as it stands, exactly as you checked the sentence you are replacing: grep for
each symbol, constant, number or behaviour it names before proposing it. A replacement that is
wrong in a new way is worse than the original, and a note duplicating the one beside it is noise.
When a comment you change states a fact that AGENTS.md or agent/docs/ also states, grep those
too and propose the matching edit.

When a task names files, read all of them or name the ones you did not reach in your final
answer. If a tool result tells you your context is filling, report what you have at once and
wrap up rather than reading on.

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
      'path:line with the matching line text. Searches source only — generated output ' +
      '(dist/, build/, node_modules/, minified files, source maps) is never searched.',
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
 * Spawn a slot's worker (idempotent server-side) and attach to its stream.
 * Spawning an id that already lives hands back the live one with its memory,
 * which is what makes an iframe reload cheap.
 */
async function ensureWorker(slot: WorkerSlot): Promise<void> {
  if (slot.stopStream) return;
  if (slot.spawning) return slot.spawning;
  slot.spawning = (async () => {
    slot.setStatus('spawning');
    const raw = await invoke('yaar://apps/self/agents', {
      action: 'spawn',
      personaId: slot.id,
      systemPrompt: WORKER_PROMPT,
      tools: WORKER_TOOLS,
      model: 'sonnet',
    });
    const handle = z.safeParse(PersonaHandleSchema, raw);
    if (!handle.success) throw new Error('spawn returned an unexpected shape');
    const stop = await stream(handle.data.streamUri, (frame) => onFrame(slot, frame), {
      kinds: ['start', 'text', 'thinking', 'done', 'error'],
    });
    slot.stopStream = stop;
    slot.setStatus('idle');
  })();
  try {
    await slot.spawning;
  } catch (err) {
    slot.setStatus('error');
    throw err;
  } finally {
    slot.spawning = null;
  }
}

/**
 * What starting a task reports. Exactly one of `taskId`/`error` is set — an
 * optional-field shape rather than a union, because app sources typecheck with
 * `strict: false`, where a union narrows on nothing.
 */
export interface StartOutcome {
  taskId?: number;
  worker?: string;
  error?: string;
}

function describeRunning(): string {
  return workerActiveTasks()
    .map((t) => `#${t.id} on ${t.worker}`)
    .join(', ');
}

/**
 * Choose a free slot within the cap. A named slot is taken or refused as asked.
 * Otherwise the slot that settled last wins (so a follow-up keeps its memory),
 * then any already-spawned slot, then the first free one.
 */
function pickSlot(worker?: string): { slot?: WorkerSlot; error?: string } {
  const cap = workerCap();
  const allowed = workerSlots.slice(0, cap);
  if (worker) {
    const named = slotById(worker);
    if (!named) {
      return { error: `No worker "${worker}". Workers are ${WORKER_IDS.join(', ')}.` };
    }
    if (!allowed.includes(named)) {
      return {
        error: `${worker} is beyond the concurrency cap (${cap}). Raise it with workerConfig first.`,
      };
    }
    if (isBusy(named)) {
      return {
        error:
          `${worker} is busy with task #${named.inflight?.record.id ?? '?'}. Collect it (workerWait), ` +
          'interrupt it, or omit `worker` to use any free one.',
      };
    }
    return { slot: named };
  }
  const free = allowed.filter((s) => !isBusy(s));
  if (!free.length) {
    return {
      error:
        `All ${cap} worker${cap === 1 ? ' is' : 's are'} busy (${describeRunning()}). Collect one ` +
        '(workerWait), stop one with workerInterrupt, or raise the cap with workerConfig — ' +
        'tasks are refused, not queued.',
    };
  }
  const slot =
    free.find((s) => s.id === lastSlotId) ?? free.find((s) => s.stopStream !== null) ?? free[0];
  return { slot };
}

/**
 * Hand a worker one task and return as soon as it is *accepted* — not when it
 * is answered. The stream folds frames into the slot as they arrive, and the
 * terminal frame (or the watchdog) settles the record.
 *
 * Two callers: the panel's Run button and the agent's `workerTask`. They differ
 * only in `wakeAgent` — the agent's own task wakes it when the answer lands.
 */
export async function startWorkerTask(
  task: string,
  opts: { wakeAgent?: boolean; fresh?: boolean; worker?: string; scope?: string[] } = {},
): Promise<StartOutcome> {
  const content = task.trim();
  if (!content) return { error: 'Empty task.' };
  if (!activeProject()) {
    appendEntry(workerSlots[0], 'error', 'No active project. Open or create one first.');
    return { error: 'No active project. Open or create one first.' };
  }
  const picked = pickSlot(opts.worker);
  if (!picked.slot) return { error: picked.error };
  const slot = picked.slot;
  slot.reserved = true;

  try {
    // After the busy check, never before it: a fresh start retires this slot's
    // worker, and doing that to a running task would destroy its answer.
    if (opts.fresh) await resetSlot(slot);

    try {
      await ensureWorker(slot);
    } catch (err) {
      appendEntry(slot, 'error', `Could not spawn the worker: ${errMsg(err)}`);
      return { error: `Could not spawn ${slot.id}: ${errMsg(err)}` };
    }

    const owed = slot.pendingFeedback;
    slot.pendingFeedback = [];
    const message = owed.length
      ? `Since your last turn:\n${owed.map((line) => `- ${line}`).join('\n')}\n\nNow: ${content}`
      : content;

    const scope = opts.scope ?? filesNamedInTask(content, files()).map((f) => f.path);
    const record: WorkerTaskRecord = {
      id: ++taskSeq,
      task: content,
      worker: slot.id,
      startedAt: Date.now(),
      ...(opts.wakeAgent ? { wakeAgent: true } : {}),
      ...(scope.length ? { scope } : {}),
    };
    batch(() => {
      appendEntry(slot, 'task', content);
      slot.setActiveTask(record);
      slot.setStatus('running');
      slot.setDraft('');
      slot.setThinking('');
    });
    slot.inflight = { record, timer: setTimeout(() => {}, 0), waiters: [] };
    slot.reserved = false;
    keepAlive(slot);

    try {
      await invoke(`yaar://apps/self/agents/${slot.id}`, { action: 'message', content: message });
    } catch (err) {
      // A fast worker can settle before `message` resolves; that answer stands.
      if (slot.inflight?.record.id !== record.id) return { taskId: record.id, worker: slot.id };
      batch(() => {
        appendEntry(slot, 'error', errMsg(err));
        slot.setStatus('idle');
      });
      settle(slot, { error: errMsg(err) });
      return { error: errMsg(err) };
    }

    return { taskId: record.id, worker: slot.id };
  } finally {
    slot.reserved = false;
  }
}

/** Longest one `workerWait` may block, kept under the app-command ceiling (180s). */
const MAX_WAIT_MS = 170_000;
export const DEFAULT_WAIT_MS = 60_000;

/** "Is task #N done, and what did it say" — `done: false` is a report, not a failure. */
export interface WaitResult {
  done: boolean;
  taskId: number | null;
  worker?: string;
  status: WorkerStatus;
  elapsedMs: number | null;
  answer?: string;
  error?: string;
  reports?: string[];
  proposals?: EditProposalSummary[];
  filesRead?: string[];
  filesNotRead?: string[];
  stopDiagnosis?: StopDiagnosis;
  /** On a timeout with no taskId: every task still running. */
  running?: number[];
}

function resultOf(record: WorkerTaskRecord): WaitResult {
  return {
    done: true,
    taskId: record.id,
    worker: record.worker,
    status: slotById(record.worker)?.status() ?? workerStatus(),
    elapsedMs: (record.endedAt ?? Date.now()) - record.startedAt,
    ...(record.answer ? { answer: record.answer } : {}),
    ...(record.error || record.answer ? {} : { error: noAnswerError(record.reports ?? []) }),
    ...(record.error ? { error: record.error } : {}),
    ...(record.reports?.length ? { reports: record.reports } : {}),
    ...(record.proposals?.length ? { proposals: record.proposals } : {}),
    ...(record.filesRead?.length ? { filesRead: record.filesRead } : {}),
    ...(record.filesNotRead?.length ? { filesNotRead: record.filesNotRead } : {}),
    ...(record.stopDiagnosis ? { stopDiagnosis: record.stopDiagnosis } : {}),
  };
}

/**
 * Collect a backgrounded task: resolve now if it has settled, otherwise block
 * until it does or `waitMs` runs out. Timing out is cheap and repeatable.
 *
 * With no `taskId`: when tasks are in flight, whichever of them settles first
 * (so a fan-out is collected one call per task); when none is, the last to settle.
 */
export function waitForWorker(
  opts: { taskId?: number; waitMs?: number } = {},
): Promise<WaitResult> {
  const waitMs = Math.max(1_000, Math.min(opts.waitMs ?? DEFAULT_WAIT_MS, MAX_WAIT_MS));
  const wanted = opts.taskId;
  const running = workerSlots.filter((s) => s.inflight !== null);

  let targets: WorkerSlot[];
  if (wanted !== undefined) {
    const slot = running.find((s) => s.inflight!.record.id === wanted);
    if (!slot) {
      const settled = settledTasks.get(wanted);
      if (settled) return Promise.resolve(resultOf(settled));
      return Promise.resolve({
        done: true,
        taskId: wanted,
        status: workerStatus(),
        elapsedMs: null,
        error:
          `No record of task #${wanted}. The last ${MAX_SETTLED} settled tasks and those in ` +
          'flight are kept — read the transcript in the "worker" state key for anything older.',
      });
    }
    targets = [slot];
  } else {
    if (!running.length) {
      const last = workerLastResult();
      if (last) return Promise.resolve(resultOf(last));
      return Promise.resolve({
        done: true,
        taskId: null,
        status: workerStatus(),
        elapsedMs: null,
        error: 'No worker has run a task yet.',
      });
    }
    targets = running;
  }

  return new Promise<WaitResult>((resolve) => {
    let answered = false;
    const timer = setTimeout(() => {
      if (answered) return;
      answered = true;
      if (targets.length === 1) {
        const record = targets[0].inflight?.record;
        if (record) {
          const proposals = proposalsOfTask(record.id);
          resolve({
            done: false,
            taskId: record.id,
            worker: record.worker,
            status: targets[0].status(),
            elapsedMs: Date.now() - record.startedAt,
            ...(record.reports?.length ? { reports: [...record.reports] } : {}),
            ...(proposals.length ? { proposals } : {}),
            ...(record.filesRead?.length ? { filesRead: [...record.filesRead] } : {}),
          });
          return;
        }
      }
      resolve({
        done: false,
        taskId: null,
        status: workerStatus(),
        elapsedMs: null,
        running: workerActiveTasks().map((t) => t.id),
      });
    }, waitMs);
    for (const slot of targets) {
      const inflight = slot.inflight!;
      const { record } = inflight;
      inflight.waiters.push((outcome) => {
        // Already answered (timed out, or another task settled first) — this
        // outcome was not delivered, so `settle` still owes its wakeup.
        if (answered) return false;
        answered = true;
        clearTimeout(timer);
        resolve({
          done: true,
          taskId: record.id,
          worker: record.worker,
          status: slot.status(),
          elapsedMs: Date.now() - record.startedAt,
          ...(outcome.answer ? { answer: outcome.answer } : {}),
          ...(outcome.error ? { error: outcome.error } : {}),
          ...(outcome.reports?.length ? { reports: outcome.reports } : {}),
          ...(outcome.proposals?.length ? { proposals: outcome.proposals } : {}),
          ...(outcome.filesRead?.length ? { filesRead: outcome.filesRead } : {}),
          ...(outcome.filesNotRead?.length ? { filesNotRead: outcome.filesNotRead } : {}),
          ...(outcome.stopDiagnosis ? { stopDiagnosis: outcome.stopDiagnosis } : {}),
        });
        return true;
      });
    }
  });
}

/**
 * Stop one slot's turn and hand back everything it produced — partial draft plus
 * reports. Target by `taskId`, by slot id, or (with neither) the only running task;
 * several running and nothing named is refused rather than guessed.
 */
export async function interruptWorker(
  opts: { taskId?: number; worker?: string } = {},
): Promise<WaitResult> {
  const running = workerSlots.filter((s) => s.inflight !== null);
  let slot: WorkerSlot | undefined;
  if (opts.taskId !== undefined) {
    slot = running.find((s) => s.inflight!.record.id === opts.taskId);
    if (!slot) {
      const settled = settledTasks.get(opts.taskId);
      if (settled) return resultOf(settled);
      return {
        done: true,
        taskId: opts.taskId,
        status: workerStatus(),
        elapsedMs: null,
        error: `Task #${opts.taskId} is not running.`,
      };
    }
  } else if (opts.worker !== undefined) {
    slot = slotById(opts.worker);
  } else if (running.length > 1) {
    return {
      done: false,
      taskId: null,
      status: workerStatus(),
      elapsedMs: null,
      running: running.map((s) => s.inflight!.record.id),
      error: `${running.length} tasks are running (${describeRunning()}) — pass taskId to say which to stop.`,
    };
  } else {
    slot = running[0];
  }
  if (slot && !slot.inflight && slot.status() === 'running') {
    // Drawn from another copy's snapshot: the turn is real, but its record lives
    // there. Stopping the worker ends the turn, and that copy settles it.
    const taskId = slot.activeTask()?.id ?? null;
    try {
      await invoke(`yaar://apps/self/agents/${slot.id}`, { action: 'interrupt' });
    } catch {
      /* already idle */
    }
    return {
      done: false,
      taskId,
      worker: slot.id,
      status: slot.status(),
      elapsedMs: null,
      error: 'That task runs in another copy of this window; its worker was told to stop.',
    };
  }
  if (!slot || !slot.inflight) {
    return {
      done: true,
      taskId: null,
      status: workerStatus(),
      elapsedMs: null,
      error: 'Nothing was running.',
    };
  }

  const stopped = slot.inflight.record;
  try {
    await invoke(`yaar://apps/self/agents/${slot.id}`, { action: 'interrupt' });
  } catch {
    /* not spawned or already idle — nothing to stop */
  }
  const draft = slot.draft().trim();
  const target = slot;
  batch(() => {
    if (draft) appendEntry(target, 'answer', `${draft}\n(interrupted)`);
    else appendEntry(target, 'error', 'Interrupted.');
    target.setDraft('');
    target.setStatus('idle');
  });
  settle(slot, { error: 'Interrupted.', ...(draft ? { answer: draft } : {}) });

  // The turn may have settled on its own between the invoke and here; the
  // answer it settled with is better than the one forced above.
  const settled = settledTasks.get(stopped.id);
  return settled
    ? resultOf(settled)
    : { done: true, taskId: stopped.id, status: workerStatus(), elapsedMs: null };
}

/** Retire one slot's worker so its next task starts with no memory. */
async function resetSlot(slot: WorkerSlot): Promise<void> {
  settle(slot, { error: 'The worker was reset.' });
  slot.stopStream?.();
  slot.stopStream = null;
  await del(`yaar://apps/self/agents/${slot.id}`).catch(() => {});
  const drop = new Set(
    workerProposals()
      .filter((p) => p.worker === slot.id)
      .map((p) => p.id),
  );
  batch(() => {
    setWorkerEntries(workerEntries().filter((e) => e.worker !== slot.id));
    slot.setDraft('');
    slot.setThinking('');
    slot.setStatus('offline');
    // Proposals go with the conversation that justified them.
    setWorkerProposals(workerProposals().filter((p) => !drop.has(p.id)));
    slot.pendingFeedback = [];
    if (workerLastResult()?.worker === slot.id) setWorkerLastResult(null);
  });
  for (const [id, record] of settledTasks) if (record.worker === slot.id) settledTasks.delete(id);
  if (lastSlotId === slot.id) lastSlotId = null;
}

/**
 * Retire every worker and clear the transcript. The next tasks spawn fresh
 * sessions with none of this memory.
 */
export async function resetWorker(): Promise<void> {
  await Promise.all(workerSlots.map((slot) => resetSlot(slot)));
  batch(() => {
    setWorkerEntries([]);
    setWorkerProposals([]);
    setWorkerLastResult(null);
  });
  settledTasks.clear();
}
