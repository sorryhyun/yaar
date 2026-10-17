/**
 * Staging and swapping a dev frontend build into `FRONTEND_DIST`.
 *
 * Split out of dev-bundler.ts so the filesystem half can be tested without a
 * bundler. The constraint it exists for: more than one dev server may run from
 * the same checkout (two `YAAR_WORKSPACE`s on different `PORT`s), and they all
 * build into the same `FRONTEND_DIST`. Workspaces isolate state, not the
 * frontend build, so nothing here may assume it is the only writer.
 *
 * - Every scratch directory carries the owning pid. A shared staging dir let one
 *   process `rmSync` another's half-built output, and the victim then swapped in
 *   an `index.html` whose `main-*.js` was gone — a blank desktop reported as a
 *   successful build.
 * - The swap moves the old dist aside rather than deleting it in place, and
 *   retries when another process lands its dist between our two renames. Every
 *   dist that reaches `FRONTEND_DIST` is one whole build, so whichever process
 *   swaps last serves a self-consistent tree.
 */

import { basename, dirname, join } from 'path';
import { existsSync, readdirSync, renameSync, rmSync } from 'fs';

/** Sibling of `dist` (same volume, so `renameSync` is atomic) a build is staged in. Git-ignored. */
export function stagingDirFor(dist: string, pid: number = process.pid): string {
  return `${dist}.staging-${pid}`;
}

/** Sibling of `dist` the previous build is moved to during a swap, then deleted. Git-ignored. */
export function asideDirFor(dist: string, pid: number = process.pid): string {
  return `${dist}.old-${pid}`;
}

/**
 * Throw unless every entry the generated `index.html` links is present in the
 * staged dir. `files` are the worker's dist-root-relative URLs (`/main-<hash>.js`).
 * No JS entry at all is the same failure — the page would boot to nothing.
 */
export function assertEntriesStaged(stageDir: string, jsFiles: string[], cssFiles: string[]): void {
  if (jsFiles.length === 0) throw new Error('bundle produced no JS entry point');
  const missing = [...jsFiles, ...cssFiles].filter(
    (f) => !existsSync(join(stageDir, f.replace(/^\//, ''))),
  );
  if (missing.length > 0) {
    throw new Error(`staged build is missing entries it links: ${missing.join(', ')}`);
  }
}

/** Rename refusals that mean "the target is (again) occupied" — POSIX says either; Windows says EPERM. */
const TARGET_OCCUPIED = new Set(['ENOTEMPTY', 'EEXIST', 'EPERM']);

/**
 * Swap `stageDir` into `dist`: move the current dist to `asideDir`, rename the
 * stage over the now-empty path, then delete the aside.
 *
 * Another process may do the same thing at any point in that sequence. If it
 * moves dist away first, our move-aside finds nothing (`ENOENT`) and that is
 * fine; if it lands its own dist between our two renames, ours is refused and
 * we go round again, moving theirs aside. Throws after `attempts` lost races —
 * the caller's retry covers it, and the dist in place is still a whole build.
 * `rename` is injectable so a test can stage that interleaving.
 */
export function swapIntoPlace(
  stageDir: string,
  dist: string,
  asideDir: string,
  { attempts = 5, rename = renameSync }: { attempts?: number; rename?: typeof renameSync } = {},
): void {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    rmSync(asideDir, { recursive: true, force: true });
    try {
      rename(dist, asideDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    try {
      rename(stageDir, dist);
      rmSync(asideDir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (!TARGET_OCCUPIED.has((err as NodeJS.ErrnoException).code ?? '')) throw err;
      lastErr = err;
    }
  }
  rmSync(asideDir, { recursive: true, force: true });
  throw lastErr;
}

/** `kill(pid, 0)` probes without signalling; `EPERM` means it exists but isn't ours. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Delete staging/aside dirs left beside `dist` by processes that are no longer
 * running (a crash or kill mid-build). A live owner's dirs, ours included, are
 * left alone. One `readdir` of dist's parent, so cheap enough to run per start.
 */
export function removeStaleBuildDirs(
  dist: string,
  isAlive: (pid: number) => boolean = isPidAlive,
): string[] {
  const name = basename(dist);
  const pattern = new RegExp(
    `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(?:staging|old)-(\\d+)$`,
  );
  const parent = dirname(dist);
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    const pid = Number(pattern.exec(entry)?.[1]);
    if (!pid || pid === process.pid || isAlive(pid)) continue;
    const path = join(parent, entry);
    rmSync(path, { recursive: true, force: true });
    removed.push(path);
  }
  return removed;
}
