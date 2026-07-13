/**
 * Ring buffer of App Protocol traffic.
 *
 * Agents can drive an app (query/command) but had no way to see what came back, or
 * what the app emitted on its own. That makes duplicate-emit and ordering bugs — the
 * exact class this traffic carries — invisible: the only way to reason about them was
 * to read the app's source and guess. Both directions are recorded here:
 *
 *   out — agent → app (manifest / query / command), completed with result or error
 *   in  — app → agent (emit on a declared channel)
 *
 * Entries are monitor-scoped window keys, matching `WindowStateRegistry`.
 */

import type { AppProtocolRequest, AppProtocolResponse } from '@yaar/shared';

/** Entries retained across all windows. Oldest are evicted first. */
const MAX_ENTRIES = 500;

/** Serialized params/results are truncated to this many chars per field. */
const MAX_FIELD_CHARS = 2000;

export interface ProtocolLogEntry {
  seq: number;
  /** Unix ms. */
  ts: number;
  windowKey: string;
  /** `out` = agent→app request, `in` = app→agent emit. */
  direction: 'out' | 'in';
  kind: 'manifest' | 'query' | 'command' | 'emit';
  /** stateKey for a query, command name for a command, channel for an emit. */
  name?: string;
  params?: unknown;
  /** Set on `out` entries once the app responds. */
  result?: unknown;
  error?: string;
  /** Round-trip time; `out` entries only. Absent while still in flight. */
  durationMs?: number;
}

const entries: ProtocolLogEntry[] = [];
let nextSeq = 1;

/** Shrink a value so one fat payload can't crowd the buffer. */
function clamp(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  const text = typeof value === 'string' ? value : safeStringify(value);
  if (text.length <= MAX_FIELD_CHARS) return value;
  return `${text.slice(0, MAX_FIELD_CHARS)}… (truncated, ${text.length} chars)`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function push(entry: ProtocolLogEntry): void {
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
}

/**
 * Record an outbound request. Returns the entry so the caller can complete it
 * with `endRequest` once the app responds (or times out).
 */
export function beginRequest(windowKey: string, request: AppProtocolRequest): ProtocolLogEntry {
  const name =
    request.kind === 'query'
      ? request.stateKey
      : request.kind === 'command'
        ? request.command
        : undefined;

  const entry: ProtocolLogEntry = {
    seq: nextSeq++,
    ts: Date.now(),
    windowKey,
    direction: 'out',
    kind: request.kind,
    ...(name ? { name } : {}),
    ...(request.kind === 'command' && request.params ? { params: clamp(request.params) } : {}),
  };
  push(entry);
  return entry;
}

/** Complete an outbound entry in place with the app's response (or a timeout). */
export function endRequest(
  entry: ProtocolLogEntry,
  response: AppProtocolResponse | null,
  durationMs: number,
): void {
  entry.durationMs = durationMs;
  if (!response) {
    entry.error = 'timeout — app did not respond';
    return;
  }
  if (response.error) {
    entry.error = response.error;
    return;
  }
  const value =
    response.kind === 'manifest'
      ? response.manifest
      : response.kind === 'query'
        ? response.data
        : response.result;
  if (value !== undefined) entry.result = clamp(value);
}

/** Record an inbound emit from an app on a declared channel. */
export function recordEmit(windowKey: string, channel: string, payload: unknown): void {
  push({
    seq: nextSeq++,
    ts: Date.now(),
    windowKey,
    direction: 'in',
    kind: 'emit',
    name: channel,
    ...(payload !== undefined ? { params: clamp(payload) } : {}),
  });
}

/**
 * Read back the log, newest last (chronological — ordering is usually the point).
 * Omit `windowKey` to read every window's traffic.
 */
export function readLog(opts: { windowKey?: string; limit?: number } = {}): ProtocolLogEntry[] {
  const { windowKey, limit = 100 } = opts;
  const matched = windowKey ? entries.filter((e) => e.windowKey === windowKey) : entries;
  return matched.slice(-limit);
}

/** Drop all entries. Test hook. */
export function clearLog(): void {
  entries.length = 0;
  nextSeq = 1;
}
