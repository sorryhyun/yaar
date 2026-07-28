#!/usr/bin/env bun
/**
 * Build the workspace packages that other packages consume as compiled output.
 *
 * `@yaar/shared` and `@yaar/compiler` publish `main: dist/index.js`, so in a fresh clone
 * every test and typecheck that imports them fails with `Cannot find module`. Only CI's
 * explicit build steps used to cover this. Wired as `pretest`/`pretypecheck` so the
 * commands that need `dist/` build it themselves. Rebuilds only when `dist/` is missing
 * or older than the newest source file.
 *
 * Usage: bun run scripts/build/ensure-deps-built.ts shared compiler
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dir, '..', '..');

/** Packages this script knows how to build, and the artifact that proves it ran. */
const TARGETS: Record<string, { dir: string; artifact: string }> = {
  shared: { dir: 'packages/shared', artifact: 'dist/index.js' },
  compiler: { dir: 'packages/compiler', artifact: 'dist/index.js' },
};

/** A lock held longer than this is assumed to belong to a killed process. */
const LOCK_STALE_MS = 5 * 60_000;
const LOCK_WAIT_MS = 180_000;
const LOCK_POLL_MS = 100;

/** Newest mtime under `dir`, or 0 when it doesn't exist. */
function newestMtime(dir: string): number {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const mtime = entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs;
    if (mtime > newest) newest = mtime;
  }
  return newest;
}

function isStale(pkgDir: string, artifact: string): boolean {
  const artifactPath = join(pkgDir, artifact);
  if (!existsSync(artifactPath)) return true;
  const built = statSync(artifactPath).mtimeMs;
  const sources = Math.max(
    newestMtime(join(pkgDir, 'src')),
    ...['package.json', 'tsconfig.json']
      .map((f) => join(pkgDir, f))
      .filter(existsSync)
      .map((f) => statSync(f).mtimeMs),
  );
  return sources > built;
}

/**
 * Take an exclusive lock, or wait for whoever holds it.
 *
 * `bun run --filter '*' test` starts every package in parallel, so several `pretest`
 * hooks can ask for the same build at once, and two `tsc` runs writing one `dist/` can
 * leave it half-written. The lock is a directory because `mkdir` is atomic.
 *
 * Returns a release function, or null if the wait timed out (we build anyway).
 */
function acquireLock(name: string): (() => void) | null {
  const lockDir = join(ROOT, 'node_modules', '.cache', `yaar-build-${name}.lock`);
  mkdirSync(join(ROOT, 'node_modules', '.cache'), { recursive: true });

  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lockDir);
      return () => rmSync(lockDir, { recursive: true, force: true });
    } catch {
      // Held by someone else — unless they died holding it.
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > LOCK_STALE_MS) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // Released between the mkdir and the stat; try again.
      }
      if (Date.now() > deadline) return null;
      Bun.sleepSync(LOCK_POLL_MS);
    }
  }
}

function ensure(name: string): void {
  const target = TARGETS[name];
  if (!target) {
    console.error(`[ensure-deps-built] Unknown package "${name}"`);
    process.exit(1);
  }
  const pkgDir = join(ROOT, target.dir);
  if (!isStale(pkgDir, target.artifact)) return;

  const release = acquireLock(name);
  try {
    // Re-check under the lock: the process we waited on has very likely just built it.
    if (!isStale(pkgDir, target.artifact)) return;

    console.log(`[ensure-deps-built] Building @yaar/${name}…`);
    const built = Bun.spawnSync(['bun', 'run', 'build'], {
      cwd: pkgDir,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    if (built.exitCode !== 0) {
      console.error(`[ensure-deps-built] @yaar/${name} failed to build`);
      process.exit(built.exitCode ?? 1);
    }
  } finally {
    release?.();
  }
}

const names = process.argv.slice(2);
if (names.length === 0) {
  console.error('[ensure-deps-built] Usage: ensure-deps-built.ts <package…>');
  process.exit(1);
}
// Sequential on purpose: compiler depends on shared, and the argument order is the
// dependency order.
for (const name of names) ensure(name);
