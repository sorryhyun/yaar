/**
 * The server package's whole test suite — every `*.test.ts` under `src/`, grouped into the
 * processes they are allowed to run in.
 *
 * The grouping rule is not here: it is `scripts/test/partitions.ts`, shared with
 * `scripts/test/partition-guard.ts` so that what this runner *does* and what the guard
 * *enforces* cannot drift apart. Read that file for why each partition exists and which
 * incident produced it. This one is the scheduler.
 *
 * Two things it deliberately does differently from the `&&` chain this replaced — a
 * `run-unit-tests.ts` that owned only `src/tests`, followed by three more `bun test`
 * invocations for remote, loopback, and integration:
 *
 *   - **It globs `src/**`, not `src/tests/**`.** The old glob plus a hardcoded extra directory
 *     meant a test file written anywhere else under `src/` — next to the module it tests, the
 *     obvious place to put one — was collected by nothing and reported by nothing. A skipped
 *     test that no one is told about is worse than a failing one.
 *   - **It runs every group and reports every group.** Under `&&`, a single unit failure meant
 *     the remote, loopback, and integration suites never ran, so a change that broke two things
 *     showed you one. Groups now run concurrently and the summary lists all of them; the exit
 *     code is still non-zero if any failed.
 */

import { Glob } from 'bun';

import { type Partition, partitionOf } from '../../../scripts/test/partitions.ts';

/** Test processes to keep in flight at once. */
const MAX_CONCURRENT = 4;

const PACKAGE_DIR = new URL('../', import.meta.url).pathname;
const REPO_PREFIX = 'packages/server/';

interface Group {
  partition: Partition;
  files: string[];
}

async function run(group: Group): Promise<boolean> {
  const { partition, files } = group;
  const args = [...files, ...(partition.parallel ? ['--parallel'] : [])];
  const proc = Bun.spawn(['bun', 'test', ...args], {
    cwd: PACKAGE_DIR,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...partition.env },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // Bun writes test results to stderr; print both under one header so concurrent children stay
  // readable instead of interleaving line by line.
  const label = `${partition.label} (${files.length} file${files.length === 1 ? '' : 's'})`;
  process.stdout.write(`\n───── ${label} ─────\n${stdout}${stderr}`);
  return exitCode === 0;
}

/** Run `tasks` with bounded concurrency, awaiting all of them. */
async function pooled<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]!();
    }
  });
  await Promise.all(workers);
  return results;
}

const glob = new Glob('src/**/*.test.ts');
const files: string[] = [];
for await (const file of glob.scan(PACKAGE_DIR)) files.push(file.replaceAll('\\', '/'));
files.sort();

const groups = new Map<string, Group>();
for (const file of files) {
  const source = await Bun.file(`${PACKAGE_DIR}${file}`).text();
  const partition = partitionOf(`${REPO_PREFIX}${file}`, source);
  if (!partition) throw new Error(`no partition for ${file} — see scripts/test/partitions.ts`);
  const group = groups.get(partition.key);
  if (group) group.files.push(file);
  else groups.set(partition.key, { partition, files: [file] });
}

// Biggest groups first: with a bounded pool, starting the long ones early is what keeps the
// wall-clock near the slowest group rather than the sum of the tail.
const ordered = [...groups.values()].sort((a, b) => b.files.length - a.files.length);

console.log(
  `[tests] ${files.length} file(s) in ${ordered.length} process(es): ` +
    ordered.map((g) => `${g.partition.label}×${g.files.length}`).join(', '),
);

const outcomes = await pooled(
  ordered.map((group) => () => run(group)),
  MAX_CONCURRENT,
);

const failed = ordered.filter((_, i) => !outcomes[i]);
if (failed.length > 0) {
  console.error(
    `\n[tests] ${failed.length} of ${ordered.length} test process(es) failed: ` +
      failed.map((g) => g.partition.label).join(', '),
  );
  process.exit(1);
}
console.log(`\n[tests] all ${ordered.length} test process(es) passed`);
