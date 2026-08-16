// Version comparison. The one place that decides whether a local copy is behind,
// ahead of, or level with the published one — see `compareVersions` for why
// "can't tell" is a distinct answer rather than a default.

/**
 * Numeric dot-parts of a semver core (ignoring any `-prerelease`/`+build` suffix),
 * or null for anything non-numeric. Mirrors the server's version guard so the
 * button's disabled state and the host's refusal agree.
 */
function parseSemver(v: string): number[] | null {
  const core = v.trim().split('+')[0].split('-')[0];
  if (!core) return null;
  const nums = core.split('.').map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0)) return null;
  return nums;
}

/** How a locally installed version stands against the published one. */
export type VersionOrder = 'newer' | 'older' | 'same' | 'unknown';

/**
 * Compare the installed version against the published one — the single answer both
 * the "Install update" branch and the publish button are derived from.
 *
 * `unknown` is returned whenever either side is absent or is not numeric dot-parts
 * (`v1.2.0`, a codename). It is deliberately a *third* answer rather than a default
 * of `newer` or `older`: the two callers want opposite things from "can't tell", and
 * folding it into either one is what let an app whose version we cannot read be
 * labelled "Publish update".
 */
export function compareVersions(local?: string, published?: string): VersionOrder {
  if (!local || !published) return 'unknown';
  const a = parseSemver(local);
  const b = parseSemver(published);
  if (!a || !b) return 'unknown';
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y ? 'newer' : 'older';
  }
  return 'same';
}