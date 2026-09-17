/**
 * `findReferences(sandbox, query)` — symbol references and callers for an app
 * sandbox, answered by the TypeScript language service.
 *
 * The service runs in one long-lived Worker, never on the calling thread: building
 * a program is synchronous and takes seconds on a large app, and the caller is the
 * server, whose event loop carries every WebSocket. The worker keeps the program
 * warm between queries and is terminated once idle, so the memory is only held
 * while someone is actually tracing code.
 *
 * Not in the bundled exe, for the same reason `typecheckSandbox` is not: there is
 * no `src/bundled-types` on disk and no worker file to start. The answer there is
 * `kind: 'unavailable'` — never an empty success, which would read as "no callers".
 */

import { join } from 'path';
import { getCompilerConfig } from '../config.js';
import { loadTypeScript } from '../load-typescript.js';
import { MODULE_ROOT } from '../paths.js';
import type { FindReferencesQuery, FindReferencesResult } from './types.js';
import type { WorkerRequest, WorkerResponse } from './worker.js';

export type * from './types.js';

export interface FindReferencesOptions {
  bundles?: string[];
  /** Per query. On expiry the worker is terminated, its warm programs with it. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const IDLE_MS = 5 * 60_000;

interface Pending {
  resolve: (result: FindReferencesResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();
let idleTimer: ReturnType<typeof setTimeout> | null = null;

/** Settle everything in flight with `result` and drop the worker. */
function failAll(result: FindReferencesResult): void {
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    p.resolve(result);
    pending.delete(id);
  }
  disposeReferencesWorker();
}

/** Terminate the worker and its warm programs. The next query starts a fresh one. */
export function disposeReferencesWorker(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  worker?.terminate();
  worker = null;
}

function getWorker(): Worker {
  if (worker) return worker;
  // The worker's own file, beside this one: `.ts` under `src/`, `.js` once built.
  const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  const created = new Worker(
    Bun.pathToFileURL(join(MODULE_ROOT, 'references', `worker${ext}`)).href,
  );
  created.unref();
  created.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
    const { id, result } = event.data;
    const p = pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(id);
    p.resolve(result);
    if (pending.size === 0) {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(disposeReferencesWorker, IDLE_MS);
      idleTimer.unref?.();
    }
  });
  created.addEventListener('error', (event: ErrorEvent) => {
    failAll({
      success: false,
      kind: 'failed',
      error: `references worker crashed: ${event.message || 'unknown error'}`,
    });
  });
  worker = created;
  return created;
}

function positiveInt(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 1;
}

/** Shape errors, answered before a worker is ever involved. */
function validate(query: FindReferencesQuery): string | null {
  if (typeof query.file !== 'string' || !query.file) return '"file" is required';
  if (query.symbol !== undefined && typeof query.symbol !== 'string') {
    return '"symbol" must be a string';
  }
  for (const key of ['line', 'column', 'maxResults'] as const) {
    if (query[key] !== undefined && !positiveInt(query[key])) {
      return `"${key}" must be a positive integer`;
    }
  }
  if (query.column !== undefined && query.line === undefined) return '"column" needs "line"';
  if (!query.symbol && query.column === undefined) {
    return 'Give "symbol", "line" + "column", or "line" + "symbol"';
  }
  return null;
}

export async function findReferences(
  sandboxPath: string,
  query: FindReferencesQuery,
  options: FindReferencesOptions = {},
): Promise<FindReferencesResult> {
  const invalid = validate(query);
  if (invalid) return { success: false, kind: 'invalid', error: invalid };

  if (getCompilerConfig().isBundledExe || !(await loadTypeScript())) {
    return {
      success: false,
      kind: 'unavailable',
      error: 'findReferences needs the TypeScript language service, which this build does not ship',
    };
  }

  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const id = nextId++;
  const target = getWorker();
  return new Promise<FindReferencesResult>((resolve) => {
    const timer = setTimeout(() => {
      // The worker is synchronous inside a query, so a stuck one cannot be told to
      // stop — only terminated, which takes every other query in flight with it.
      failAll({
        success: false,
        kind: 'timeout',
        error: `findReferences did not answer within ${Math.round(timeoutMs / 1000)}s`,
      });
    }, timeoutMs);
    pending.set(id, { resolve, timer });
    target.postMessage({
      id,
      root: sandboxPath,
      bundles: options.bundles ?? [],
      query,
    } satisfies WorkerRequest);
  });
}
