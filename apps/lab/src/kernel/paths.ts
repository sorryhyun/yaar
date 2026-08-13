/**
 * Path rules for the kernel's `store` helper. Two tiers, and the tier is chosen by the
 * path's *form* — there is no flag and no ambient mode.
 *
 *   DEFAULT — this app's private storage (apps/lab/)
 *     "notebooks/index.json"              relative
 *     "/state.json"                       leading slash ignored
 *     "app:scratch.csv"                   explicit
 *     "yaar://apps/self/storage/x.json"   absolute
 *     "yaar://apps/lab/storage/x.json"    absolute, naming the app by id
 *
 *   EXPLICIT — the shared storage tree, subject to the yaar://storage/ permission in app.json
 *     "yaar://storage/shared/lab/x.png"   absolute; the sanctioned way out of app storage
 *     "/api/storage/shared/lab/x.png"     the same file as an HTTP route spells it
 *     "shared:shared/lab/x.png"           shorthand
 *     "shared" / "shared/..."             bare shorthand for the shared tree, so the
 *                                         paths plot.save / exportChart take read the
 *                                         same way they are stored
 *
 * Trailing slashes, doubled slashes and "." segments normalise away instead of throwing.
 * ".." is refused outright: traversal used to escape app storage into neighbouring apps,
 * and a URI is now the only way out.
 *
 * Reading the dialects apart is the SDK's `storagePath`, which folds every spelling of a
 * storage reference onto one root-relative path. What stays here is what is genuinely
 * this app's: the two shorthands, the bare-path default, and the *tier* each resolved
 * path belongs to — none of which the SDK has an opinion about.
 */

import { storagePath } from '@bundled/yaar';

const SHARED_URI = 'yaar://storage';
const SELF_URI = 'yaar://apps/self/storage';

/** This app's own tree, under either spelling the storage root uses for it. */
const OWN_ROOTS = ['apps/self/', 'apps/lab/'];

/**
 * A reference written in one of the URI/URL dialects, as opposed to a bare path or one
 * of the `app:`/`shared:` shorthands below.
 *
 * The distinction is the whole two-tier rule: a dialect says which tree it means, a
 * bare path does not and therefore defaults to this app's storage. Reading the dialects
 * apart is `storagePath`'s job, but *whether* one was used has to be asked of the raw
 * string, because after resolution `notebooks/x.json` and `yaar://storage/notebooks/x.json`
 * are the same string and mean opposite tiers.
 */
const DIALECT = /^(yaar:\/\/|https?:\/\/|\/?api\/storage(\/|$))/i;

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

/** The part of a resolved storage path inside this app's own tree, or null. */
function stripOwnRoot(resolved: string): string | null {
  for (const root of OWN_ROOTS) {
    if (resolved === root.slice(0, -1)) return '';
    if (resolved.startsWith(root)) return resolved.slice(root.length);
  }
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

  if (p.startsWith('app:')) {
    p = p.slice(4);
  } else if (p.startsWith('shared:')) {
    shared = true;
    p = p.slice(7);
  } else if (DIALECT.test(p)) {
    // `storagePath` reads every spelling of a storage reference — both URI dialects
    // and the `/api/storage/` URL — so this branch decides only which *tier* the
    // resolved path lands in, not how to parse it.
    const resolved = storagePath(p);
    if (resolved === null) {
      // `storagePath` answers null for a traversing path as well as for a reference
      // that is not storage at all. Traversal has its own message, so ask separately
      // rather than reporting "unsupported URI" for a URI that was perfectly well formed.
      if (p.split('/').includes('..')) normalize(p, op, original);
      throw new Error(
        `store.${op}: unsupported URI '${original}'. Use 'yaar://storage/<path>' for shared ` +
          `storage, 'yaar://apps/self/storage/<path>' or a bare path for this app's storage.`,
      );
    }
    const own = stripOwnRoot(resolved);
    if (own !== null) {
      p = own;
    } else if (resolved.startsWith('apps/')) {
      throw new Error(
        `store.${op}: '${original}' names another app's storage, which this app cannot reach.`,
      );
    } else {
      shared = true;
      p = resolved;
    }
  } else if (p === 'shared' || p.startsWith('shared/')) {
    shared = true;
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
