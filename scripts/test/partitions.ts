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
 *   - **`mock.module` is process-global and has no teardown.** `mock.restore()`
 *     cannot undo it once the real module has loaded, so a stub installed by one
 *     file is visible to every other file in the process, and which file wins is a
 *     race rather than an order. That race is not theoretical: `app-agent-model.test.ts`
 *     passed locally and failed in CI because four other files stub the
 *     `agents/profiles/index.js` barrel.
 *   - **Some suites own real resources and are sequential-only.** Running the 80
 *     non-remote server files in one `--parallel` process fails 45 of them; the same
 *     80 run sequentially pass. Two cannot overlap with anything: `src/tests/loopback/`
 *     (real stack, `FakeClient` + `ScriptedProvider`) binds real sockets, and
 *     `src/tests/realfs/` drives real `git` over one on-disk fixture directory that its
 *     cases reseed. Neither is the *integration* suite — that is `packages/tests/`,
 *     a separate package and therefore already a separate partition.
 *
 * Plus one that is about the harness rather than the code under test: **the root
 * preload sets up exactly one package per process.** `scripts/test/preload-root.ts`
 * dispatches on the anchored package because the setups are mutually exclusive —
 * the frontend installs happy-dom globals, and `shims/yaar/define-app.ts` branches on
 * `typeof window`, so a global DOM quietly sends the compiler's tests down the browser
 * path. Two packages in one process therefore means one of them ran unconfigured.
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
  /** May the group's files run concurrently inside their one process (`bun test --parallel`)? */
  parallel: boolean;
  /** Command that runs this group correctly, quoted in the guard's error. */
  howToRun: string;
}

/**
 * Does this file install a module mock?
 *
 * Comment lines are dropped first — several files *discuss* `mock.module` in prose (the
 * loopback harness explains at length why it does not use one), and counting those would
 * isolate files that never mock anything.
 */
export function installsModuleMock(source: string): boolean {
  const code = source
    .split('\n')
    .filter((line) => {
      const t = line.trimStart();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
  return /\bmock\.module\s*\(/.test(code);
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
 * `repoRel` is repo-relative and posix-separated (`packages/server/src/tests/x.test.ts`);
 * `source` is the file's text, needed only for the `mock.module` scan. Returns `null` for a
 * path outside `packages/` — there are none today, and inventing a rule for a file we cannot
 * see is how a guard starts lying.
 */
export function partitionOf(repoRel: string, source: string): Partition | null {
  const pkg = /^packages\/([^/]+)\//.exec(repoRel)?.[1];
  if (!pkg) return null;

  const inPackage = repoRel.slice(`packages/${pkg}/`.length);
  const base: Pick<Partition, 'env' | 'parallel'> = { env: {}, parallel: false };

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

  // Directory rules come first: a file under one of these is that suite's, whether or not it
  // also mocks. `src/tests/loopback/` is additionally forbidden from mocking at all (see
  // packages/server/CLAUDE.md), so the two rules do not actually compete there.
  if (inPackage.startsWith('src/tests/remote/')) {
    return {
      key: 'server:remote',
      label: 'remote',
      reason:
        'asserts remote mode, and IS_REMOTE is a module-load constant — REMOTE=1 has to be ' +
        'pinned for the whole process or the assertions are vacuous',
      env: { YAAR_TEST_REMOTE: '1' },
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
        'resolves real paths through PROJECT_ROOT, so it cannot share a process with the ' +
        "units — several of them mock.module it to '/mock-root' and the stub has no teardown",
      howToRun: 'cd packages/server && bun test src/tests/realfs',
    };
  }
  if (installsModuleMock(source)) {
    return {
      ...base,
      key: `server:mock:${repoRel}`,
      label: `mock:${inPackage}`,
      reason:
        'installs mock.module, which is process-global with no teardown — its stub would be ' +
        'visible to every other file in the process, so it gets a process to itself',
      howToRun: `cd packages/server && bun test ${inPackage}`,
    };
  }
  return {
    key: 'server:units',
    label: 'units',
    reason: 'is a plain unit test, which the suite runs concurrently in one shared process',
    env: {},
    parallel: true,
    howToRun: 'bun run --filter @yaar/server test',
  };
}
