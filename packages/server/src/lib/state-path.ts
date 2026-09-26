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

// ── Path-listing search ─────────────────────────────────────────────────────────────

/** One leaf of a value: its pasteable path, and where it sits under its parent. */
interface Leaf {
  path: string;
  parent: string;
  key: string;
  line: string;
}

/**
 * A `pattern` search over a JSON value, answered in paths rather than line numbers.
 *
 * The line grep this replaces searched *indented* JSON — `"name": "HandL"`, space after the
 * colon — while the model had only ever been shown that value compact, through
 * `structuredContent`: `"name":"HandL"`. So a pattern written from what the model saw
 * matched nothing, and the ones that did match came back as `2386│ "width": 0.07,` with no
 * way to tell which of two hundred nodes the line belonged to.
 *
 * Here every leaf is one line, `path: value`, and the pattern is tested against that line.
 * There is no JSON punctuation to guess at, a key's ancestors are part of the text a
 * pattern can match, and every path is one `selectStatePath` accepts — so a match's path
 * pasted after the read URI reads that part. Array elements are spelled by `id` when the
 * element has a unique one, `__idx/{n}` otherwise, for the reason `INDEX_SEGMENT` gives.
 *
 * `addressable` says whether `label` walks paths — true for an app's state, whose read runs
 * `selectStatePath`; false for a value the window answers itself (`__content`), whose URI
 * takes no path. Only an addressable header tells the reader to append one: a hint that
 * 404s is worse than none.
 *
 * `context: N` is siblings, not lines: the N entries on either side of a match *under the
 * same parent*, grouped under that parent's path. Siblings that are themselves objects or
 * arrays are summarized (`{p, r, s}`, `[2]`), so asking for a node's name shows its id and
 * kind rather than the next forty lines of its transform.
 */
export function searchValuePaths(
  value: unknown,
  label: string,
  pattern: string,
  context = 0,
  addressable = false,
): string {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    return `Invalid regex pattern: "${pattern}"`;
  }

  const leaves: Leaf[] = [];
  collectLeaves(value, '', leaves);
  const matched = leaves.filter((leaf) => regex.test(leaf.line));
  if (matched.length === 0) {
    return `No matches for /${pattern}/ in ${label} (${leaves.length} values, searched as "path: value" lines)`;
  }

  const counts = `${matched.length} of ${leaves.length} values match`;
  const header = addressable
    ? `── ${label} (${counts}; read ${label}/{path} for one part) ──`
    : `── ${label} (${counts}; paths are relative to it) ──`;

  if (context <= 0) return `${header}\n${matched.map((leaf) => leaf.line).join('\n')}`;

  // Group by parent, in first-match order; each group shows its matches ±context siblings.
  const groups = new Map<string, Set<string>>();
  for (const leaf of matched) {
    const keys = groups.get(leaf.parent) ?? new Set<string>();
    const siblings = entriesOf(parentValue(value, leaf.parent));
    const at = siblings.findIndex(([k]) => k === leaf.key);
    for (let i = Math.max(0, at - context); i <= Math.min(siblings.length - 1, at + context); i++) {
      keys.add(siblings[i][0]);
    }
    groups.set(leaf.parent, keys);
  }

  const blocks = [...groups].map(([parent, keys]) => {
    const entries = entriesOf(parentValue(value, parent)).filter(([k]) => keys.has(k));
    const lines = entries.map(([k, v]) => `  ${k}: ${summarize(v)}`);
    return `${parent || '(root)'}/\n${lines.join('\n')}`;
  });
  return `${header}\n${blocks.join('\n──\n')}`;
}

function collectLeaves(value: unknown, path: string, out: Leaf[]): void {
  const entries = isContainer(value) ? entriesOf(value) : [];
  if (entries.length === 0) {
    if (!path) return;
    const { parent, key } = splitLast(path);
    out.push({ path, parent, key, line: `${path}: ${summarize(value)}` });
    return;
  }
  for (const [key, child] of entries) collectLeaves(child, path ? `${path}/${key}` : key, out);
}

/** A path's parent and last step — where `__idx/{n}` counts as one step. */
function splitLast(path: string): { parent: string; key: string } {
  const parts = path.split('/');
  const last = parts.pop() ?? '';
  if (parts.at(-1) === INDEX_SEGMENT && /^\d+$/.test(last)) {
    parts.pop();
    return { parent: parts.join('/'), key: `${INDEX_SEGMENT}/${last}` };
  }
  return { parent: parts.join('/'), key: last };
}

/** A container's children as `[step, value]`, each step spelled the way the walker reads it. */
function entriesOf(value: unknown): Array<[string, unknown]> {
  if (Array.isArray(value)) {
    const ids = value.map((item) =>
      isRecord(item) && (typeof item.id === 'string' || typeof item.id === 'number')
        ? String(item.id)
        : null,
    );
    const counts = new Map<string, number>();
    for (const id of ids) if (id !== null) counts.set(id, (counts.get(id) ?? 0) + 1);
    return value.map((item, i) => {
      const id = ids[i];
      const step =
        id !== null && id !== INDEX_SEGMENT && counts.get(id) === 1
          ? encodeStep(id)
          : `${INDEX_SEGMENT}/${i}`;
      return [step, item];
    });
  }
  if (isRecord(value)) return Object.entries(value).map(([k, v]) => [encodeStep(k), v]);
  return [];
}

/** The value at a listing path — the listing's own spelling, so the walk cannot miss. */
function parentValue(root: unknown, path: string): unknown {
  if (!path) return root;
  const walked = selectStatePath(root, '', splitStatePath(`_/${path}`).path);
  return walked.ok ? walked.value : undefined;
}

/** A segment that holds a `/`, `%` or whitespace is percent-encoded so it survives the URI. */
function encodeStep(step: string): string {
  return /[/%\s]/.test(step) ? encodeURIComponent(step) : step;
}

/** A leaf as JSON; a container as its shape — `{p, r, s}` or `[2]`. */
function summarize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.length}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value);
    const shown = keys.slice(0, 6).join(', ');
    return `{${keys.length > 6 ? `${shown}, …` : shown}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function isContainer(value: unknown): boolean {
  return Array.isArray(value) || isRecord(value);
}
