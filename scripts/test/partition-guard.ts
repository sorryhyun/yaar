/**
 * Refuses a `bun test` run that would mix test files which cannot share one process.
 *
 * `scripts/test/env.ts` fixed the *environment* half of "a test run describes the code, not the
 * machine": what a process reads from `config/settings.json`, `.env`, and the shell. This file
 * fixes the other half, which the root `bunfig.toml` promised and could not deliver — what a
 * process is allowed to *contain*.
 *
 * The gap was measurable. `bun test packages/server` from the repo root reported **86 failures**
 * against a tree whose suite is green, because one process cannot be both remote and local, and
 * because `mock.module` has no teardown. Every one of those failures was an artifact of the run
 * shape. A developer who trusted the output would go looking for bugs that are not there; one
 * who learned not to trust it has lost the command. `scripts/test/partitions.ts` records which
 * files may share a process and why — this turns that record into an error.
 *
 * **How.** A `Bun.plugin` `onLoad` hook fires for each `*.test.ts(x)` as the runner loads it, in
 * the same process, before the file is evaluated. The first one decides the process's partition;
 * a later one from a different partition prints both files with their reasons and exits non-zero.
 * The plugin returns the file's own contents unchanged (returning `undefined` to fall through
 * aborts the run with no output on Bun 1.3), so the only observable effect is the refusal.
 *
 * **Why not check the arguments up front?** They are not available. A preload sees `Bun.main` —
 * the first collected file — and nothing else; the CLI path arguments are gone by then, and they
 * are substring filters rather than paths anyway (`bun test src/tests/remote` also collects
 * `src/tests/remote-token.test.ts`). Watching the loads is the only view of the real file set,
 * and it costs one `readFileSync` per test file.
 *
 * The consequence worth stating: the error arrives *after* the first partition's files have run,
 * because that is when the offending file loads. The run still fails, and it names the fix.
 *
 * Wired from the root `bunfig.toml` (which is where the cross-package and whole-package mixes
 * come from) and from `packages/server/bunfig.toml` (where `bun test src/tests` mixes the
 * server's own suites). The other packages are each a single partition, so there is nothing
 * there for this to catch.
 */

import { readFileSync, writeSync } from 'node:fs';

import { type Partition, partitionOf, toRepoRelative } from './partitions.ts';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;

/** The partition this process committed to, set by the first test file it loaded. */
let held: { partition: Partition; file: string } | null = null;

function refuse(incoming: { partition: Partition; file: string }): never {
  const a = held!;
  const b = incoming;
  // `writeSync(2, …)`, not `console.error`: Bun buffers stderr when it is a pipe, and
  // `process.exit()` discards what is still buffered. The first version of this guard used
  // console.error and its message survived on a terminal but vanished under `| tail` and in
  // CI — a guard that fails silently is worse than no guard, because the run still dies and
  // now nothing says why.
  writeSync(
    2,
    [
      '',
      '  ✖ This `bun test` run mixes test files that cannot share one process.',
      '    Results from a mixed process are wrong, not merely slower — so the run stops here.',
      '',
      `    ${a.file}`,
      `      → [${a.partition.label}] ${a.partition.reason}`,
      '',
      `    ${b.file}`,
      `      → [${b.partition.label}] ${b.partition.reason}`,
      '',
      '    Run one partition at a time:',
      `      ${a.partition.howToRun}`,
      `      ${b.partition.howToRun}`,
      '',
      '    Or run the whole suite the way CI does, which fans out per package and per',
      '    partition:',
      '      bun run test',
      '',
      '    See scripts/test/partitions.ts for the rule and the incidents behind it.',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

/**
 * Bun loads a test file just before it runs it, so the refusal lands between two files'
 * output. Exiting here rather than throwing is deliberate: a throw from `onLoad` is swallowed
 * on Bun 1.3 — the run stops with a non-zero code and no explanation at all.
 */

Bun.plugin({
  name: 'yaar-test-partition-guard',
  setup(build) {
    build.onLoad({ filter: /\.test\.tsx?$/ }, (args) => {
      const source = readFileSync(args.path, 'utf8');
      const loader = args.path.endsWith('x') ? 'tsx' : 'ts';

      const rel = toRepoRelative(args.path, REPO_ROOT);
      const partition = rel ? partitionOf(rel, source) : null;
      if (partition) {
        if (!held) held = { partition, file: rel! };
        else if (held.partition.key !== partition.key) refuse({ partition, file: rel! });
      }

      return { contents: source, loader };
    });
  },
});
