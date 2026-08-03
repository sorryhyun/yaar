/**
 * Path rules for the kernel's `store` helper. Two tiers, and the tier is chosen by the
 * path's *form* — there is no flag and no ambient mode.
 *
 *   DEFAULT — this app's private storage (apps/lab/)
 *     "notebooks/index.json"              relative
 *     "/state.json"                       leading slash ignored
 *     "app:scratch.csv"                   explicit
 *     "yaar://apps/self/storage/x.json"   absolute
 *
 *   EXPLICIT — the shared storage tree, subject to the yaar://storage/ permission in app.json
 *     "yaar://storage/media/lab/x.png"    absolute; the sanctioned way out of app storage
 *     "shared:media/lab/x.png"            shorthand
 *     "media" / "media/..."               legacy shorthand for the shared media tree, kept
 *                                         so notebooks written before the URI form existed
 *                                         (and plot.save / exportChart) keep working
 *
 * Trailing slashes, doubled slashes and "." segments normalise away instead of throwing.
 * ".." is refused outright: traversal used to escape app storage into neighbouring apps,
 * and a URI is now the only way out.
 */

const SHARED_URI = 'yaar://storage';
const SELF_URI = 'yaar://apps/self/storage';

export interface ResolvedPath {
  /** True when the path targets the shared tree rather than this app's storage. */
  shared: boolean;
  /** Normalised path relative to whichever root `shared` selects; '' is that root. */
  path: string;
  /**
   * The resolved location as a canonical URI, for error messages. Deliberately not the
   * physical path: under the devtools preview the app principal is `preview--{id}`, so a
   * hard-coded `apps/lab/` would be a lie there. The backend's own message carries the
   * physical path; this carries the form a caller can copy back into `store`.
   */
  display: string;
  /** What the caller passed, echoed back verbatim. */
  raw: string;
}

/** Strip `prefix` (with or without a trailing slash) off `p`, or null if it isn't there. */
function stripPrefix(p: string, prefix: string): string | null {
  if (p === prefix || p === prefix + '/') return '';
  if (p.startsWith(prefix + '/')) return p.slice(prefix.length + 1);
  return null;
}

/** Collapse empty and "." segments; refuse "..". */
function normalize(p: string, op: string, original: string): string {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      throw new Error(
        `store.${op}: '..' is not allowed in a path (got '${original}'). Paths are relative to ` +
          `this app's storage; use 'yaar://storage/<path>' to reach shared storage.`,
      );
    }
    out.push(seg);
  }
  return out.join('/');
}

/**
 * Resolve a caller-supplied path to a root and a normalised path.
 * `op` names the calling operation in error messages; `allowRoot` permits the empty
 * path, which only `list` has a meaning for.
 */
export function resolvePath(
  raw: string,
  op = 'read',
  opts: { allowRoot?: boolean } = {},
): ResolvedPath {
  const original = typeof raw === 'string' ? raw : String(raw ?? '');
  let p = original.trim();
  let shared = false;

  const self = stripPrefix(p, SELF_URI);
  const sharedRest = self === null ? stripPrefix(p, SHARED_URI) : null;

  if (self !== null) {
    p = self;
  } else if (sharedRest !== null) {
    shared = true;
    p = sharedRest;
  } else if (p.startsWith('app:')) {
    p = p.slice(4);
  } else if (p.startsWith('shared:')) {
    shared = true;
    p = p.slice(7);
  } else if (p === 'media' || p.startsWith('media/')) {
    shared = true;
  } else if (/^yaar:\/\//i.test(p)) {
    throw new Error(
      `store.${op}: unsupported URI '${original}'. Use 'yaar://storage/<path>' for shared ` +
        `storage, 'yaar://apps/self/storage/<path>' or a bare path for this app's storage.`,
    );
  }

  const path = normalize(p, op, original);
  if (!path && !opts.allowRoot) {
    throw new Error(`store.${op}: empty path`);
  }

  return {
    shared,
    path,
    display: (shared ? SHARED_URI : SELF_URI) + '/' + path,
    raw: original,
  };
}
