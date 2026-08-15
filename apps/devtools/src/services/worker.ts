export {};
import { createSignal, batch } from '@bundled/solid-js';
import { invoke, del, stream, errMsg, type StreamFrame } from '@bundled/yaar';
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

export const [workerStatus, setWorkerStatus] = createSignal<WorkerStatus>('offline');
export const [workerEntries, setWorkerEntries] = createSignal<WorkerEntry[]>([]);
/** Accumulated text deltas of the turn in flight. */
export const [workerDraft, setWorkerDraft] = createSignal('');
/** Accumulated thinking deltas — shown behind a fold. */
export const [workerThinking, setWorkerThinking] = createSignal('');

/** Unsubscribe thunk for the live stream. Not reactive — nothing renders it. */
let stopStream: (() => void) | null = null;
/** The turn in flight, resolved by the stream's terminal frame or the watchdog. */
let pending: {
  resolve: (outcome: TurnOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
} | null = null;
/** A spawn in flight, so two rapid Run clicks don't race two spawns. */
let spawning: Promise<void> | null = null;

function appendEntry(kind: WorkerEntry['kind'], text: string): void {
  setWorkerEntries([...workerEntries(), { kind, text, timestamp: Date.now() }]);
}

/** Settle the turn in flight once, whatever ended it, and stop its watchdog. */
function settle(outcome: TurnOutcome): void {
  if (!pending) return;
  clearTimeout(pending.timer);
  const { resolve } = pending;
  pending = null;
  resolve(outcome);
}

/** Restart the silence watchdog — any frame or tool call counts as progress. */
function keepAlive(): void {
  if (!pending) return;
  clearTimeout(pending.timer);
  pending.timer = setTimeout(() => {
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
 * Give the worker one task and wait for the answer.
 *
 * The await is on the *stream*, not on the verb: `message` returns as soon as
 * the turn is queued, and the terminal frame (or the watchdog) settles it. One
 * turn at a time — a task sent while one is in flight is refused with a busy
 * outcome rather than queued, and the server's own busy refusal backs that up.
 *
 * Two callers, one function: the panel's Run button and the app agent's
 * `workerTask` command. Both land every task and answer in the same transcript
 * signals, which is what keeps the panel a faithful window on agent-driven work.
 */
export async function runWorkerTask(task: string): Promise<TurnOutcome> {
  const content = task.trim();
  if (!content) return { error: 'Empty task.' };
  if (pending) {
    return {
      error:
        'The worker is already on a task. Wait for it to finish — its status and answer ' +
        'are in the "worker" state key.',
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

  batch(() => {
    appendEntry('task', content);
    setWorkerStatus('running');
    setWorkerDraft('');
    setWorkerThinking('');
  });

  const answered = new Promise<TurnOutcome>((resolve) => {
    pending = { resolve, timer: setTimeout(() => {}, 0) };
  });
  keepAlive();

  try {
    await invoke(`yaar://apps/self/agents/${WORKER_ID}`, { action: 'message', content });
  } catch (err) {
    batch(() => {
      appendEntry('error', errMsg(err));
      setWorkerStatus('idle');
    });
    settle({ error: errMsg(err) });
  }

  return answered;
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
  });
}
