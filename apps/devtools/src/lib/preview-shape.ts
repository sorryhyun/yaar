export {};

// Shaping what preview and search reads hand back to the agent: pure, so the cuts can be
// pinned by the lib suite without a running preview.

/** How much of one grep line comes back. A source line is shorter; a fixture line is not. */
export const GREP_LINE_CHARS = 300;

/**
 * One grep hit, cut to `max` characters centred on the match.
 *
 * A JSON fixture or a generated table puts thousands of characters on one line, and a
 * hit returned whole is that whole line — eleven of them were ~50KB of one answer. The
 * match is re-found locally to centre the window; a pattern this engine cannot compile,
 * or one that no longer matches, falls back to the line's head, which is still a cut.
 */
export function clipMatchLine(content: string, pattern: string, max = GREP_LINE_CHARS): string {
  if (content.length <= max) return content;
  let start = 0;
  let end = 0;
  try {
    const m = new RegExp(pattern).exec(content);
    if (m) {
      start = m.index;
      end = m.index + m[0].length;
    }
  } catch {
    /* not a JS regex — clip from the head */
  }
  // Centre on the match; a match longer than the window shows its own head.
  let from = Math.max(0, Math.floor((start + Math.min(end, start + max)) / 2 - max / 2));
  from = Math.min(from, content.length - max);
  const to = from + max;
  const before = from > 0 ? `…[+${from} chars] ` : '';
  const after = to < content.length ? ` …[+${content.length - to} chars]` : '';
  return `${before}${content.slice(from, to)}${after}`;
}

/**
 * Top-level fields of one state value, as `previewQuery({ stateKey, keys })` reads them.
 * Null when the value has no fields to pick (a primitive, an array, null).
 */
export function pickFields(
  value: unknown,
  keys: string[],
): { value: Record<string, unknown>; missing: string[]; available: string[] } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) picked[k] = obj[k];
    else missing.push(k);
  }
  return { value: picked, missing, available: Object.keys(obj) };
}

export interface NumericRange {
  min: number;
  max: number;
  last: number;
  /** Samples in which this path held a number; fewer than the total means it came and went. */
  n: number;
}

/** A cap on summarized paths, so a value holding a sample buffer cannot become the answer. */
export const MAX_SUMMARY_PATHS = 200;

function numericLeaves(value: unknown, path: string, out: Map<string, number>): void {
  if (out.size >= MAX_SUMMARY_PATHS) return;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) out.set(path || '(value)', value);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);
  for (const [k, v] of entries) numericLeaves(v, path ? `${path}.${k}` : k, out);
}

/**
 * Min, max and last of every numeric leaf across a series of samples, keyed by dotted
 * path (`levels.master`, `tracks.3.gain`). What a meter or a playhead *did* over a window
 * reads off this in one line; the raw series is for when the order matters.
 */
export function summarizeSamples(values: unknown[]): {
  numeric: Record<string, NumericRange>;
  pathsCapped?: boolean;
} {
  const ranges = new Map<string, NumericRange>();
  let capped = false;
  for (const v of values) {
    const leaves = new Map<string, number>();
    numericLeaves(v, '', leaves);
    if (leaves.size >= MAX_SUMMARY_PATHS) capped = true;
    for (const [path, n] of leaves) {
      const r = ranges.get(path);
      if (r) {
        r.min = Math.min(r.min, n);
        r.max = Math.max(r.max, n);
        r.last = n;
        r.n++;
      } else if (ranges.size < MAX_SUMMARY_PATHS) {
        ranges.set(path, { min: n, max: n, last: n, n: 1 });
      } else {
        capped = true;
      }
    }
  }
  return { numeric: Object.fromEntries(ranges), ...(capped ? { pathsCapped: true } : {}) };
}

/** How much of one Dev Tools audit entry the console reads keep when collapsed. */
export const AUDIT_ENTRY_CHARS = 160;

/**
 * An audit entry (a `previewEval` input or result, a fault-rule change) cut to one line.
 * They are replays of calls the reader made itself, so the full text is noise there;
 * `full` on the console read brings it back.
 */
export function collapseAuditText(text: string, max = AUDIT_ENTRY_CHARS): string {
  const flat = text.replace(/\s*\n\s*/g, ' ');
  return flat.length > max ? `${flat.slice(0, max)}… (${text.length} chars)` : flat;
}
