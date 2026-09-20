/**
 * Which process a test file has to run in — the one definition, shared by the two
 * things that need it.
 *
 * Some test files cannot share a Bun process with some others. Not "should not":
 * the run reports wrong results if they do, and it reports them confidently. Three
 * independent reasons, each measured rather than assumed:
 *
 *   - **`REMOTE=1` is a property of the process.** `IS_REMOTE` is a module-load
 *     constant (`config/env.ts`), so `packages/server/src/tests/remote/` can only
 *     assert anything if remote mode was pinned before the first import. In a
 *     local-mode process `checkHttpAuth` returns `null` on its first line and every
 *     assertion in that file passes vacuously — or, as it happens today, fails.
 *   - **Some suites own real resources and cannot overlap with anything.**
 *     `src/tests/loopback/` (real stack, `FakeClient` + `ScriptedProvider`) binds real
 *     sockets, and `src/tests/realfs/` drives real `git` over one on-disk fixture
 *     directory that its cases reseed — one shared path, so two of its files running
 *     at once reseed under each other. Both are therefore sequential, non-isolated
 *     groups of their own. Neither is the *integration* suite — that is `packages/tests/`, a
 *     separate package and therefore already a separate partition.
 *   - **The root preload sets up exactly one package per process.**
 *     `scripts/test/preload-root.ts` dispatches on the anchored package because the
 *     setups are mutually exclusive — the frontend installs happy-dom globals, and
 *     `shims/yaar/define-app.ts` branches on `typeof window`, so a global DOM quietly
 *     sends the compiler's tests down the browser path. Two packages in one process
 *     therefore means one of them ran unconfigured.
 *
 * **One reason used to be here and no longer is.** `mock.module` is process-global and
 * `mock.restore()` cannot undo it once the real module has loaded, so until Bun 1.4
 * every file installing one needed a process to itself — 15 files, 15 processes — and
 * a stub that escaped produced order-dependent failures rather than a red line
 * (`app-agent-model.test.ts` passed locally and failed in CI because four other files
 * stub the `agents/profiles/index.js` barrel). `bun test --isolate` runs each file in
 * a fresh global with the module registry cleared, which is precisely the teardown
 * that was missing. Measured on 1.4.0 before the rule was deleted: all 143 unit +
 * mocking files pass in one `--parallel` process, and pass again in a single
 * `--isolate` process in sorted *and* reversed order. The `units` partition therefore
 * **depends on** `--isolate`, which is why `run-tests.ts` passes that flag explicitly
 * instead of leaning on `--parallel` to imply it — and why `isolate` and `parallel` are
 * two fields below rather than one. `units` runs isolated and *sequential*: `--parallel`
 * crashes a worker on a suite this size about one run in ten (oven-sh/bun#41357, #41055,
 * both open), and a crashed worker aborts the whole run, so the speed was being paid for
 * in false failures. Nothing about the isolation changed with it.
 *
 * Two consumers, so that the rule cannot drift from its enforcement:
 *
 *   - `packages/server/scripts/run-tests.ts` groups by partition and spawns one
 *     process per group. This is how `bun run test` gets correct results.
 *   - `scripts/test/partition-guard.ts` watches what a single process actually loads
 *     and kills the run the moment a second partition appears. This is how an ad-hoc
 *     `bun test <path>` gets *an error* instead of wrong results.
 */

/** How a group of test files must be run. */
export interface Partition {
  /** Identity. Same key ⇒ may share a process; different keys ⇒ must not. */
  key: string;
  /** Short name for runner headers and guard messages. */
  label: string;
  /** Why this file cannot share a process. Printed by the guard, so write it for a human. */
  reason: string;
  /** Environment the group's process needs on top of the pinned baseline. */
  env: Record<string, string>;
  /**
   * Does each of the group's files get a fresh global and module registry (`--isolate`)?
   *
   * This is the correctness half, and `units` depends on it: it is the only thing keeping
   * the `mock.module` stubs in those files out of each other. `false` means the group keeps
   * one global across its files, which is what a suite holding a real socket or a real
   * fixture directory wants — and is also the only mode the partition guard can observe,
   * since an isolated file cannot tell a second one exists (see `partition-guard.ts`).
   */
  isolate: boolean;
  /**
   * May the group's files run concurrently, in worker processes (`--parallel`)?
   *
   * Separate from `isolate` because Bun couples them one way only: `--parallel` implies
   * `--isolate`, but `--isolate` stands alone. Keeping them apart is what lets a group be
   * isolated *without* being parallel — see `units`, which is exactly that.
   *
   * Nothing sets this today; it stays because the axis is real and turning it back on when
   * Bun fixes the worker crash is meant to be a one-word change, not a redesign.
   */
  parallel: boolean;
  /** Command that runs this group correctly, quoted in the guard's error. */
  howToRun: string;
}

/** Absolute path → repo-relative posix path, or `null` if it is outside the repo. */
export function toRepoRelative(absPath: string, repoRoot: string): string | null {
  const path = absPath.replaceAll('\\', '/');
  const root = repoRoot.replaceAll('\\', '/').replace(/\/$/, '');
  return path.startsWith(root + '/') ? path.slice(root.length + 1) : null;
}

/**
 * The partition of one test file.
 *
 * `repoRel` is repo-relative and posix-separated (`packages/server/src/tests/x.test.ts`).
 * Path alone decides it — the rule stopped needing the file's *text* when the `mock.module`
 * scan went away, which is why `run-tests.ts` no longer reads all 143 files to schedule them.
 * Returns `null` for a path outside `packages/` — there are none today, and inventing a rule
 * for a file we cannot see is how a guard starts lying.
 *
 * Only `server` gets named sub-partitions. Every other package is one partition derived from
 * its directory name, so a new workspace package — `@yaar/lib` was the last one — is covered
 * the moment it has a test file, with no edit here. Add a branch only for a package that
 * genuinely cannot run its own files in one process.
 */
export function partitionOf(repoRel: string): Partition | null {
  const pkg = /^packages\/([^/]+)\//.exec(repoRel)?.[1];
  if (!pkg) return null;

  const inPackage = repoRel.slice(`packages/${pkg}/`.length);
  const base: Pick<Partition, 'env' | 'isolate' | 'parallel'> = {
    env: {},
    isolate: false,
    parallel: false,
  };

  if (pkg !== 'server') {
    return {
      ...base,
      key: pkg,
      label: pkg,
      reason:
        `belongs to @yaar/${pkg}; scripts/test/preload-root.ts configures exactly one package ` +
        "per process, because the packages' setups are mutually exclusive — the frontend's " +
        "happy-dom globals decide which branch the compiler's tests take",
      howToRun: `bun run --filter @yaar/${pkg} test`,
    };
  }

  // Three directories, then everything else. `src/tests/loopback/` is additionally forbidden
  // from calling `mock.module` at all (see packages/server/CLAUDE.md) — not because the stub
  // would leak, which `--isolate` has settled, but because the harness's whole point is that
  // it substitutes through real seams.
  if (inPackage.startsWith('src/tests/remote/')) {
    return {
      key: 'server:remote',
      label: 'remote',
      reason:
        'asserts remote mode, and IS_REMOTE is a module-load constant — REMOTE=1 has to be ' +
        'pinned for the whole process or the assertions are vacuous',
      env: { YAAR_TEST_REMOTE: '1' },
      isolate: false,
      parallel: false,
      howToRun: 'cd packages/server && YAAR_TEST_REMOTE=1 bun test src/tests/remote/',
    };
  }
  if (inPackage.startsWith('src/tests/loopback/')) {
    return {
      ...base,
      key: 'server:loopback',
      label: 'loopback',
      reason:
        'is part of the loopback harness, which boots the real stack on real sockets and ' +
        'cannot overlap with another suite in the same process',
      howToRun: 'cd packages/server && bun test src/tests/loopback',
    };
  }
  if (inPackage.startsWith('src/tests/realfs/')) {
    return {
      ...base,
      key: 'server:realfs',
      label: 'realfs',
      reason:
        'drives real git over one on-disk fixture directory that its own cases reseed, so it ' +
        'runs sequentially in a process of its own rather than alongside the parallel units',
      howToRun: 'cd packages/server && bun test src/tests/realfs',
    };
  }
  return {
    key: 'server:units',
    label: 'units',
    reason:
      'is a plain unit test, which the suite runs in one --isolate process, each file in a ' +
      'fresh global',
    env: {},
    isolate: true,
    parallel: false,
    howToRun: 'bun run --filter @yaar/server test',
  };
}
