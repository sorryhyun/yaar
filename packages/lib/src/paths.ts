/**
 * Path containment — is a path inside a base directory, or did it escape?
 *
 * The wrong way to ask this is `relative(base, target).includes('..')`: a directory
 * legitimately named `a..b` contains the string `..` without going anywhere, and that
 * substring check rejects it. The right way only cares whether the relative path *climbs
 * out* — starts with `..` — or lands on a different root entirely (`isAbsolute`, which is
 * what `relative()` returns when `target` is on another drive on Windows).
 */

import { isAbsolute, join, normalize, relative } from 'node:path';
import { realpath } from 'node:fs/promises';

/** Does the already-absolute `candidate` sit at or under the already-absolute `base`? */
function withinBase(base: string, candidate: string): boolean {
  const rel = relative(base, candidate);
  return !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Join `target` onto `base` and confirm the result doesn't escape it.
 *
 * Returns the resolved absolute path, or `null` if `target` climbs out of `base` via `..`
 * segments (or, on Windows, names a different drive). `target` itself may be relative or
 * absolute — `path.join` treats either the same way, as a path to resolve under `base`.
 */
export function containedPath(base: string, target: string): string | null {
  const resolved = normalize(join(base, target));
  return withinBase(base, resolved) ? resolved : null;
}

/** `containedPath(base, target) !== null`, for callers that only need the boolean. */
export function isContained(base: string, target: string): boolean {
  return containedPath(base, target) !== null;
}

/**
 * Whether the already-absolute `candidate` sits at or under `base`, without joining.
 *
 * For checking a path obtained independently of `base` — a mount's host directory, say —
 * rather than a caller-supplied one that should be resolved relative to it. Joining an
 * absolute `candidate` onto `base` (as `containedPath` does) would concatenate them
 * instead of asking whether one contains the other.
 */
export function isPathWithin(base: string, candidate: string): boolean {
  return withinBase(base, candidate);
}

/**
 * Symlink-aware `containedPath`: resolves both sides with `realpath` before checking, so a
 * symlink that lives inside `base` but points outside it cannot be used to escape.
 *
 * Falls back to the plain `containedPath` result when `target` doesn't exist yet — a write
 * path has nothing on disk to resolve, and the sync check above already approved it.
 */
export async function containedRealPath(base: string, target: string): Promise<string | null> {
  const resolved = containedPath(base, target);
  if (!resolved) return null;
  try {
    const [realBase, realTarget] = await Promise.all([realpath(base), realpath(resolved)]);
    return withinBase(realBase, realTarget) ? realTarget : null;
  } catch {
    return resolved;
  }
}
