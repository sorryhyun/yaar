/**
 * Root `[test] preload` — the half of "make `bun test <path>` work from the repo
 * root" that `test/env.ts` cannot do.
 *
 * Bun reads `bunfig.toml` from the **current directory**, not from the test
 * file's package. So `bun test packages/tests/src/integration/http-routing.test.ts`
 * run from the root loaded no preload at all: the environment was the developer's,
 * and a machine with `remote: true` persisted in `config/settings.json` failed six
 * cases in that file for reasons having nothing to do with the code. Wrong results,
 * not an error — the worst shape a test harness can fail in, and precisely what
 * `test/env.ts` was written to prevent for the per-package runs.
 *
 * The root bunfig fixes the environment half by preloading `test/env.ts` first
 * (order there is load-bearing — it has to win before `config/env.ts` freezes
 * `IS_REMOTE`). This file covers the rest: two packages need setup beyond the
 * environment, and neither can be loaded unconditionally.
 *
 *   - **frontend** installs happy-dom's globals. Loading that for every root run
 *     would change what the *compiler* tests see: `shims/yaar/define-app.ts`
 *     branches on `typeof window` / `typeof document` — deliberately, see the
 *     "do not simplify away" comment there — so a global DOM would quietly send
 *     those tests down the browser path and assert nothing about the server one.
 *   - **server** materializes `dist/protocol.json` fixtures. That needs a built
 *     `@yaar/compiler` and is pure wasted work for every other package.
 *
 * So it dispatches on the package the run is anchored in. `process.argv[1]` is the
 * first test file Bun collected, which for any run scoped to a single package — a
 * file, a directory, or a path substring — names that package. Verified for all
 * three forms; the preload itself runs once per *process*, not per file, so this
 * is the only signal available.
 *
 * That single anchor is also this file's limit, and the reason it has a companion.
 * A run scoped to one package is configured correctly here; a run that *spans*
 * packages, or that mixes the server's own suites, gets one package's setup and
 * silently wrong results for the rest — and a preload cannot fix it, because the fix
 * is more processes, not more setup. `scripts/test/partition-guard.ts` watches what
 * the process actually loads and refuses those runs by name. Between the two: every
 * single-partition path works, and everything else is an error rather than an answer.
 * `scripts/test/partitions.ts` holds the rule and the incidents behind it.
 *
 * Use `bun run test` for the whole suite; it fans out per package with each package's
 * own bunfig. Nothing here changes those runs: they have cwd inside the package, so
 * the root bunfig is never consulted.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Setup a package needs beyond the pinned environment, keyed by package dir name. */
const PACKAGE_SETUP: Record<string, () => Promise<unknown>> = {
  // Relative specifiers, not a path joined at runtime: they resolve against this
  // module's URL on every platform, and stay greppable from the files they name.
  frontend: () => import('../../packages/frontend/src/tests/test-setup.ts'),
  server: () => import('../../packages/server/src/tests/setup/materialize-app-protocols.ts'),
};

const anchor = (process.argv[1] ?? '').replaceAll('\\', '/');
const pkg = anchor.match(/\/packages\/([^/]+)\//)?.[1];

if (pkg) {
  runPretest(pkg);
  await PACKAGE_SETUP[pkg]?.();
}

/**
 * Run the anchored package's own `pretest` script, which `bun test` skips.
 *
 * `bun run test` executes npm lifecycle hooks; `bun test` is the runner itself and
 * executes none. Four of the five packages declare `pretest: ensure-deps-built.ts
 * shared [compiler]`, because `@yaar/shared` and `@yaar/compiler` are consumed as
 * `dist/` — so without this a root `bun test` silently tests whatever build happened
 * to be lying around, or fails with `Cannot find module` in a fresh clone. Stale
 * dependencies are the same silent-wrongness this preload exists to rule out.
 *
 * Invoked by *script name* rather than by reimplementing the command, so a package
 * that changes its pretest gets that change here for free. `build/ensure-deps-built.ts`
 * rebuilds only when `dist/` is older than the newest source, so the common path is
 * an mtime scan (~25ms); a genuinely stale tree pays the build it owed anyway.
 *
 * Synchronous on purpose: it must finish before any test file imports the packages
 * it builds, and a preload's own top-level await does not order against that.
 */
function runPretest(packageName: string): void {
  const dir = new URL(`../../packages/${packageName}/`, import.meta.url).pathname;

  let pkgJson: { scripts?: Record<string, string> };
  try {
    pkgJson = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
  } catch {
    return; // not a workspace package — nothing to run
  }
  if (!pkgJson.scripts?.pretest) return;

  const proc = Bun.spawnSync(['bun', 'run', 'pretest'], {
    cwd: dir,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      `[test-preload-root] \`bun run pretest\` failed in packages/${packageName} (exit ${proc.exitCode}).\n` +
        'Its dependencies are unbuilt, so the run would test stale output. Fix the build, or use `bun run test`.',
    );
  }
}
