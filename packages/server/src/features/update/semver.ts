/**
 * Version comparison for the self-updater.
 *
 * Deliberately a local ~60-line implementation rather than a dependency: the only
 * versions ever compared here are ones *we* produce — `scripts/release/set-version.ts`
 * stamps `package.json`, the tag mirrors it, and `resolveVersion()` reads one or the
 * other. The full semver range grammar (`^1.2 || >=3`) has no caller.
 *
 * The one case that is not ours is `0.0.0-unknown`, the fallback `resolveVersion()`
 * returns when neither the compile-time define nor `package.json` answered. Under
 * semver's own rules a prerelease sorts *below* the same release, so that value is
 * older than every published version and the updater offers an update rather than
 * concluding "up to date" from a version it never actually learned.
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers, empty for a release version. */
  prerelease: string[];
}

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parse a semver string (with or without a leading `v`). Returns null if it is not one. */
export function parseVersion(raw: string): ParsedVersion | null {
  const match = VERSION_RE.exec(raw.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

/** Strip a leading `v` so a tag and a package version can be compared as one spelling. */
export function normalizeVersion(raw: string): string {
  return raw.trim().replace(/^v/, '');
}

function comparePrerelease(a: string[], b: string[]): number {
  // A version with no prerelease outranks one that has any (1.0.0 > 1.0.0-rc.1).
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    // A shorter run of identifiers is lower precedence when all else is equal.
    if (x === undefined) return -1;
    if (y === undefined) return 1;

    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff < 0 ? -1 : 1;
      continue;
    }
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (xNum !== yNum) return xNum ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Compare two versions: negative if `a < b`, 0 if equal, positive if `a > b`.
 *
 * An unparsable version sorts below a parsable one, and two unparsable versions
 * compare equal. That keeps `isNewer` honest without throwing on a hand-edited
 * `package.json` — the caller gets "an update is available", not a crash.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;

  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

/** True when `candidate` is a strictly later version than `current`. */
export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(normalizeVersion(candidate), normalizeVersion(current)) > 0;
}
