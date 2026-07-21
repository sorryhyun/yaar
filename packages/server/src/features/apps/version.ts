/**
 * Publish version policy — refuse to upload a version that is not newer than what
 * the marketplace already serves.
 *
 * Publishing only ever *pushes* the local copy up (see `publishButton`'s doc), so a
 * re-push of an already-published version is almost always an accident: the
 * publisher forgot to bump `app.json`. The marketplace enforces its own version
 * policy server-side, but catching it here means the user hears "bump the version"
 * before we package, freeze, and upload a tarball the market would only reject.
 *
 * The check is **best-effort and fail-open**: if the catalog is unreachable or the
 * app is not published yet, we allow the publish and let the marketplace be the
 * backstop. We only ever block on a concrete "published version ≥ local version".
 */

import { join } from 'path';
import { readFile } from 'fs/promises';
import { fetchPublishedVersion } from '../market/marketplace.js';

/** Read `app.json`'s `version`, or null if absent/unreadable. */
export async function readAppVersion(appDir: string): Promise<string | null> {
  try {
    const meta = JSON.parse(await readFile(join(appDir, 'app.json'), 'utf8')) as {
      version?: unknown;
    };
    return typeof meta.version === 'string' ? meta.version : null;
  } catch {
    return null;
  }
}

/**
 * Numeric dot-parts of a semver core, ignoring any `-prerelease`/`+build` suffix.
 * Returns null for anything non-numeric so the caller can fall back to "allow".
 */
export function parseSemver(v: string): number[] | null {
  const core = v.trim().split('+')[0].split('-')[0];
  if (!core) return null;
  const nums = core.split('.').map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0)) return null;
  return nums;
}

/**
 * Is `local` a strictly newer version than `published`? Unparseable versions
 * compare as "newer" (true) — never block a publish on a version string we cannot
 * reason about; the marketplace remains the authority.
 */
export function isNewerVersion(local: string, published: string): boolean {
  const a = parseSemver(local);
  const b = parseSemver(published);
  if (!a || !b) return true;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false; // equal → not newer
}

/**
 * The publish-blocking reason, or null if the version is publishable.
 *
 * `publishedVersionOf` is injectable purely so tests can drive the policy without a
 * network call; production uses the real marketplace catalog fetch.
 */
export async function versionPublishError(
  appId: string,
  localVersion: string | null,
  publishedVersionOf: (id: string) => Promise<string | null> = fetchPublishedVersion,
): Promise<string | null> {
  const published = await publishedVersionOf(appId).catch(() => null);
  if (!published) return null; // first publish, or catalog unreachable → allow
  if (localVersion && !isNewerVersion(localVersion, published)) {
    return (
      `Version ${localVersion} is not newer than the published version ${published}. ` +
      `Bump "version" in app.json before publishing.`
    );
  }
  return null;
}
