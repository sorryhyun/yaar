/**
 * `yaar://windows/{w}/state/{key}/{seg}/{seg}…` — addressing *into* a state value.
 *
 * An app answers for whole keys: `scene` is the entire scene document, thousands of lines
 * pretty-printed. The only way to see one node's geometry used to be `pattern`, a line grep
 * over that document, which finds `"geometry": {` two hundred times and says of none of them
 * which node it belongs to. A path says which part you mean, so the answer is that part.
 *
 * The walk is server-side, after the app answered for the key: every app gets it, and no
 * app has to know it exists. That is only sound because no app declares a state key with a
 * `/` in it — the first segment is always the key. `splitStatePath` is where that
 * assumption lives.
 *
 * Each step is an object key or — for an array of objects — the `id` of an element. That
 * is what makes a tree addressable by the names it already uses: scene nodes, deck slides
 * and sheet rows carry ids, and a positional index into them goes stale the moment
 * something is inserted before it.
 *
 * A position is spelled `__idx/{n}`, never a bare number. A bare `12` meant "index 12" and
 * so made an element whose id *is* `"12"` unreachable — the common case for rows keyed by
 * a database id. The `__` prefix says what it says on state keys (`__screenshot`): this
 * segment is YAAR's syntax, not a name from the app's data.
 */

/** The segment that makes the next one a position rather than a name. */
export const INDEX_SEGMENT = '__idx';

/** The app-facing key and the path to walk inside its value. */
export function splitStatePath(stateKey: string): { key: string; path: string[] } {
  const [key, ...rest] = stateKey.split('/');
  return { key, path: rest.filter((seg) => seg.length > 0).map(decodeSegment) };
}

/** `%2F` and friends — a segment that must contain a `/` or a space can still be spelled. */
function decodeSegment(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

export type StatePathResult = { ok: true; value: unknown } | { ok: false; message: string };

/** How many keys or ids a miss names before it stops listing. */
const MAX_LISTED = 20;

/** Walk `path` into `value`. A miss says where it stopped and what was there instead. */
export function selectStatePath(value: unknown, key: string, path: string[]): StatePathResult {
  let current = value;
  for (let i = 0; i < path.length; i++) {
    const at = `state/${[key, ...path.slice(0, i)].join('/')}`;
    let seg = path[i];
    let next: Step;
    if (seg === INDEX_SEGMENT) {
      seg = `${INDEX_SEGMENT}/${path[i + 1] ?? ''}`;
      if (!Array.isArray(current)) {
        return { ok: false, message: `${at} is not an array, so "${seg}" has nothing to count.` };
      }
      next = byIndex(current, path[++i]);
    } else {
      next = step(current, seg);
    }
    if (next.found) {
      current = next.value;
      continue;
    }
    return { ok: false, message: `${at} has no "${seg}". ${whatIsThere(current)}` };
  }
  return { ok: true, value: current };
}

type Step = { found: true; value: unknown } | { found: false };

function byIndex(array: unknown[], seg: string | undefined): Step {
  if (seg === undefined || !/^\d+$/.test(seg)) return { found: false };
  const index = Number(seg);
  return index < array.length ? { found: true, value: array[index] } : { found: false };
}

function step(current: unknown, seg: string): Step {
  if (Array.isArray(current)) {
    const byId = current.find(
      (item) => isRecord(item) && (item.id === seg || String(item.id) === seg),
    );
    return byId === undefined ? { found: false } : { found: true, value: byId };
  }
  if (isRecord(current) && Object.hasOwn(current, seg)) {
    return { found: true, value: current[seg] };
  }
  return { found: false };
}

/** The refusal's second half: the names that *would* have worked at this level. */
function whatIsThere(current: unknown): string {
  if (Array.isArray(current)) {
    const ids = current.flatMap((item) =>
      isRecord(item) && (typeof item.id === 'string' || typeof item.id === 'number')
        ? [String(item.id)]
        : [],
    );
    return (
      `It is an array of ${current.length} — step by position with ${INDEX_SEGMENT}/{0-${Math.max(current.length - 1, 0)}}` +
      (ids.length ? ` or by id: ${listed(ids)}.` : '.')
    );
  }
  if (isRecord(current)) return `Its keys: ${listed(Object.keys(current))}.`;
  return `It is a ${current === null ? 'null' : typeof current}, which has no parts.`;
}

function listed(names: string[]): string {
  const shown = names.slice(0, MAX_LISTED).join(', ');
  return names.length > MAX_LISTED ? `${shown}, … (${names.length} total)` : shown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
