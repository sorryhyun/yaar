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
  kind: 'manifest' | 'query' | 'command' | 'eval' | 'emit';
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
        : // An eval has no name but the expression *is* the interesting part, and a log
          // that showed a bare `eval` row would say nothing about what was asked.
          request.kind === 'eval'
          ? request.expression
          : undefined;

  // `__console` is not app traffic — it is devtools polling its own console panel, twice a
  // second, each poll carrying back the whole accumulated buffer. Recorded, it buried the
  // handful of entries the log exists to show (a command, its result) under dozens of
  // identical replays of the same logs. Instrumentation must not drown the signal it
  // instruments, so the poll is watched, not logged.
  const isConsolePoll = request.kind === 'query' && request.stateKey === '__console';

  const entry: ProtocolLogEntry = {
    seq: isConsolePoll ? -1 : nextSeq++,
    ts: Date.now(),
    windowKey,
    direction: 'out',
    kind: request.kind,
    ...(name ? { name } : {}),
    ...(request.kind === 'command' && request.params ? { params: clamp(request.params) } : {}),
  };
  // `endRequest` still completes the entry; it just completes one nobody reads.
  if (!isConsolePoll) push(entry);
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
      ? summarizeManifest(response.manifest)
      : response.kind === 'query'
        ? response.data
        : response.kind === 'eval'
          ? response.value
          : response.result;
  if (value !== undefined) entry.result = clamp(value);
}

/**
 * A manifest entry records that the manifest was fetched, not the manifest.
 *
 * Full manifests are the largest thing in this buffer by an order of magnitude — a
 * description plus a params schema plus a URI for every command and every state key,
 * which pretty-printed is ~90 lines *each* and stays under `clamp`'s limit, so
 * nothing trimmed it. Four of them in one 30-entry read is a thousand lines of
 * duplicate text crowding out the query/command/emit rows this log exists to show.
 * The names are what a reader of an ordering bug needs; the schemas are one
 * `describe` away.
 */
function summarizeManifest(manifest: unknown): unknown {
  if (!manifest || typeof manifest !== 'object') return manifest;
  const m = manifest as Record<string, unknown>;
  const names = (value: unknown): string[] | undefined => {
    if (Array.isArray(value)) {
      return value.map((v) =>
        typeof v === 'string'
          ? v
          : String((v as { name?: unknown } | null)?.name ?? JSON.stringify(v)),
      );
    }
    if (value && typeof value === 'object') return Object.keys(value);
    return undefined;
  };
  const commands = names(m.commands);
  const state = names(m.state);
  const events = names(m.events);
  // A shape this does not recognize is passed through rather than summarized into
  // `{}`: an unreadable entry is worse than a fat one.
  if (!commands && !state && !events) return manifest;
  return {
    summarized: 'names only — call describe for descriptions and params schemas',
    ...(commands ? { commands } : {}),
    ...(state ? { state } : {}),
    ...(events ? { events } : {}),
  };
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
 *
 * `kind` narrows to the traffic asked about. It matters because the reader is
 * usually also the *writer*: an agent inspecting an app leaves a row for every
 * query it made, so the emits it came to check ordering on sit behind dozens of
 * entries it produced itself. Filtering is done here, before `limit`, so
 * `{ kind: ['emit'], limit: 30 }` means the last thirty emits — not whichever
 * emits happen to fall inside the last thirty entries of any kind.
 */
export function readLog(
  opts: { windowKey?: string; limit?: number; kind?: ProtocolLogEntry['kind'][] } = {},
): ProtocolLogEntry[] {
  const { windowKey, limit = 100, kind } = opts;
  const kinds = kind && kind.length > 0 ? new Set(kind) : null;
  const matched = entries.filter(
    (e) => (!windowKey || e.windowKey === windowKey) && (!kinds || kinds.has(e.kind)),
  );
  return matched.slice(-limit);
}

/** Drop all entries. Test hook. */
export function clearLog(): void {
  entries.length = 0;
  nextSeq = 1;
}
