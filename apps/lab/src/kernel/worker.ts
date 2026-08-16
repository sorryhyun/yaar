import { createSignal } from '@bundled/solid-js';
import { KERNEL_SRC } from './source';
import { handleBridgeCall } from './bridge';
import type { RunResult } from '../types';

/**
 * Main-thread lifecycle for the compute worker: one worker at a time, one run at
 * a time (the kernel has a single shared scope), and a hard timeout that can only
 * be enforced by terminating — there is no soft interrupt for `while (true)`.
 */

export const DEFAULT_TIMEOUT_MS = 30000;

export interface RunOptions {
  timeoutMs?: number;
  agent?: boolean;
  resultLimit?: number;
  saveResultTo?: string;
  label?: string;
}

const [busy, setBusy] = createSignal(false);
const [runningLabel, setRunningLabel] = createSignal('');
const [restarts, setRestarts] = createSignal(0);

export { busy, runningLabel, restarts };

type Pending = { resolve: (r: RunResult) => void; timer: number };

let worker: Worker | null = null;
let blobUrl: string | null = null;
let seq = 0;
const pending = new Map<string, Pending>();
let queue: Promise<unknown> = Promise.resolve();

function emptyResult(name: string, message: string, durationMs: number): RunResult {
  return { ok: false, logs: [], parts: [], durationMs, error: { name, message, stack: '' } };
}

function ensureWorker(): Worker {
  if (worker) return worker;
  if (!blobUrl) {
    blobUrl = URL.createObjectURL(new Blob([KERNEL_SRC], { type: 'text/javascript' }));
  }
  const w = new Worker(blobUrl);
  w.onmessage = (ev: MessageEvent) => onMessage(w, ev.data);
  w.onerror = (ev: ErrorEvent) => {
    console.error('[lab] kernel worker error', ev.message);
  };
  worker = w;
  return w;
}

async function onMessage(w: Worker, msg: any): Promise<void> {
  if (!msg) return;
  if (msg.type === 'bridge') {
    let reply: any;
    try {
      const value = await handleBridgeCall(msg.method, msg.args);
      reply = { type: 'bridgeResult', callId: msg.callId, ok: true, value };
    } catch (e) {
      reply = {
        type: 'bridgeResult',
        callId: msg.callId,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
    if (worker === w) w.postMessage(reply);
    return;
  }
  if (msg.type === 'result') {
    const p = pending.get(msg.runId);
    if (!p) return;
    pending.delete(msg.runId);
    clearTimeout(p.timer);
    const { type, runId, ...rest } = msg;
    p.resolve(rest as RunResult);
  }
}

/** Kill the worker and settle every in-flight run with `message`. */
function hardStop(message: string): void {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  const inflight = Array.from(pending.entries());
  pending.clear();
  for (const [, p] of inflight) {
    clearTimeout(p.timer);
    p.resolve(emptyResult('KernelStopped', message, 0));
  }
  setBusy(false);
  setRunningLabel('');
}

function exec(code: string, opts: RunOptions): Promise<RunResult> {
  const w = ensureWorker();
  const runId = String(++seq);
  const timeoutMs = Math.max(100, opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  setBusy(true);
  setRunningLabel(opts.label || 'running');
  return new Promise<RunResult>((resolve) => {
    const timer = window.setTimeout(() => {
      pending.delete(runId);
      hardStop('timeout');
      setRestarts(restarts() + 1);
      resolve(
        emptyResult(
          'TimeoutError',
          'Execution exceeded ' +
            timeoutMs +
            'ms and was aborted. The kernel restarted, so variables from earlier cells are gone.',
          timeoutMs,
        ),
      );
    }, timeoutMs);
    pending.set(runId, { resolve, timer });
    w.postMessage({
      type: 'run',
      runId,
      code,
      agent: !!opts.agent,
      resultLimit: opts.resultLimit,
      saveResultTo: opts.saveResultTo,
    });
  }).then((r) => {
    if (pending.size === 0) {
      setBusy(false);
      setRunningLabel('');
    }
    return r;
  });
}

/** Queue one execution. Runs are serialised — the kernel has a single scope. */
export function runInKernel(code: string, opts: RunOptions = {}): Promise<RunResult> {
  const next = queue.then(
    () => exec(code, opts),
    () => exec(code, opts),
  );
  queue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/** Terminate the worker mid-run. Everything in flight resolves as cancelled. */
export function cancelRun(): void {
  if (!worker && pending.size === 0) return;
  hardStop('Cancelled. The kernel restarted, so variables from earlier cells are gone.');
  setRestarts(restarts() + 1);
}

/** Restart the worker, clearing the shared scope. */
export function resetKernel(): void {
  hardStop('Kernel reset.');
  setRestarts(restarts() + 1);
  ensureWorker();
}
