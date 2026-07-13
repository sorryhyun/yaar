/**
 * Log policy for iframe verb calls (`POST /api/verb`).
 *
 * Every call an app's SDK makes lands here, and apps make a *lot* of them: a
 * reader app rendering a feed fires one `invoke yaar://http` per link preview,
 * each carrying a full header block. Logging those verbatim buries the entries
 * that actually describe what happened in the session.
 *
 * Two rules:
 *  - `yaar://http` is an app's `fetch()` — data plane, not a desktop action. Skip it.
 *  - Everything else is logged with its payload summarized: headers dropped,
 *    long strings and arrays collapsed, nesting capped.
 */

/** URIs whose traffic is pure data movement — high volume, no signal in the log. */
const DATA_PLANE_URIS = ['yaar://http'];

const MAX_STRING = 120;
const MAX_KEYS = 12;

/** Whether an iframe verb call is worth a session-log entry. */
export function shouldLogVerb(uri: string): boolean {
  return !DATA_PLANE_URIS.some((prefix) => uri === prefix || uri.startsWith(`${prefix}/`));
}

/**
 * Summarize a verb payload for the log: keeps the shape recognizable, drops the bulk.
 * Returns undefined when nothing survives, so `{ verb, uri }` stays clean.
 */
export function compactVerbPayload(payload: unknown): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_KEYS) {
      out['…'] = 'truncated';
      break;
    }
    if (key === 'headers') continue; // never carries session-level meaning
    out[key] = summarize(value, 1);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function summarize(value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_STRING
      ? `${value.slice(0, MAX_STRING)}… (${value.length} chars)`
      : value;
  }
  if (Array.isArray(value)) {
    return depth > 1
      ? `[${value.length} items]`
      : value.slice(0, 3).map((v) => summarize(v, depth + 1));
  }
  if (value && typeof value === 'object') {
    if (depth > 1) return '{…}';
    const nested: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (Object.keys(nested).length >= MAX_KEYS) {
        nested['…'] = 'truncated';
        break;
      }
      nested[k] = summarize(v, depth + 1);
    }
    return nested;
  }
  return value;
}
