export {};
import { createSignal, batch } from '@bundled/solid-js';
import { app, invoke, del, stream, errMsg, type StreamFrame } from '@bundled/yaar';
import * as z from '@bundled/zod';
import { activeProject } from '../core';
import { PersonaHandleSchema, WorkerFrameDataSchema } from '../schema';

// The worker sub-agent — a sonnet-tier explorer devtools spawns for itself via
// `yaar://apps/self/agents` (requires the user-granted `subagents` capability in
// app.json). The worker holds NO YAAR verbs and no filesystem: its only reach is
// the three read-only tools declared at spawn, each of which the server routes
// back to this iframe as a `persona:{name}` command (handlers: protocol/worker.ts,
// which run against devtools' own storage grants). Containment, not plumbing —
// the worker can never see more of the machine than devtools itself shows it.
//
// One worker, not a cast: `app.json` says `"subagents": { "max": 1 }`, the id is
// fixed, and the provider session is persistent — successive tasks are turns of
// one conversation, so "now check the other file" works as a follow-up. `reset`
// is the fresh-context escape hatch.

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
  kind: 'task' | 'answer' | 'tool' | 'error';
  text: string;
  timestamp: number;
}

/**
 * How one task ended. `answer` may accompany `error` — the partial draft of a
 * turn that went quiet or was interrupted is worth more than the error alone.
 */
export interface TurnOutcome {
  answer?: string;
  error?: string;
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

/** Settle the turn in flight once, whatever ended it, and stop its watchdog. */
function settle(outcome: TurnOutcome): void {
  if (!inflight) return;
  clearTimeout(inflight.timer);
  const { record, waiters } = inflight;
  inflight = null;
  const finished: WorkerTaskRecord = {
    ...record,
    endedAt: Date.now(),
    ...(outcome.answer ? { answer: outcome.answer } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
  };
  batch(() => {
    setWorkerActiveTask(null);
    setWorkerLastResult(finished);
  });
  let served = false;
  for (const resolve of waiters) served = resolve(outcome) || served;

  // The event goes out either way — a subscriber watching this channel wants
  // every settle. What is conditional is the *wakeup*, and on two things: the
  // agent started this task, and no `workerWait` of its own just answered it.
  // Without the second, an agent that chose to block would be woken a turn later
  // to be told what it had already been handed.
  app?.emit(
    'worker',
    {
      taskId: finished.id,
      task: finished.task,
      ...(finished.answer ? { answer: finished.answer } : {}),
      ...(finished.error ? { error: finished.error } : {}),
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
      setWorkerDraft(workerDraft() + (data.content ?? ''));
      break;
    case 'thinking':
      setWorkerThinking(workerThinking() + (data.content ?? ''));
      break;
    case 'done': {
      // `done` carries the authoritative final text; the draft is the fallback
      // for a stream that dropped a delta.
      const text = (data.text ?? workerDraft()).trim();
      batch(() => {
        if (text) appendEntry('answer', text);
        setWorkerDraft('');
        setWorkerStatus('idle');
      });
      settle({ answer: text });
      break;
    }
    case 'error': {
      const message = data.error ?? 'stream error';
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

Your tools are read-only. You cannot edit files, compile, or run anything — for a task that
needs a change, report exactly what you found and the precise edit you would make (file, line,
before/after), so the caller can apply it.

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
  opts: { wakeAgent?: boolean } = {},
): Promise<StartOutcome> {
  const content = task.trim();
  if (!content) return { error: 'Empty task.' };
  if (inflight) {
    return {
      error:
        `The worker is already on task #${inflight.record.id}. Collect that one first ` +
        '(workerWait, or the "worker" state key) — tasks are refused, not queued.',
    };
  }
  if (!activeProject()) {
    appendEntry('error', 'No active project. Open or create one first.');
    return { error: 'No active project. Open or create one first.' };
  }

  try {
    await ensureWorker();
  } catch (err) {
    appendEntry('error', `Could not spawn the worker: ${errMsg(err)}`);
    return { error: `Could not spawn the worker: ${errMsg(err)}` };
  }

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
    await invoke(`yaar://apps/self/agents/${WORKER_ID}`, { action: 'message', content });
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
}

/** Project a settled record into the wait result shape. */
function resultOf(record: WorkerTaskRecord): WaitResult {
  return {
    done: true,
    taskId: record.id,
    status: workerStatus(),
    elapsedMs: (record.endedAt ?? Date.now()) - record.startedAt,
    ...(record.answer ? { answer: record.answer } : {}),
    ...(record.error ? { error: record.error } : {}),
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
      });
      return true;
    });
  });
}

/** Stop the turn in flight. The partial draft is kept as the answer so far. */
export async function interruptWorker(): Promise<void> {
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
    // The last result goes with the transcript it belonged to. Keeping it would
    // hand the next `workerWait` an answer from a conversation that no longer
    // exists — the one reading a reset worker is least equipped to catch.
    setWorkerLastResult(null);
  });
}
