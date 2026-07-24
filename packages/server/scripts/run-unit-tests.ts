/**
 * Unit-suite runner — partitions `src/tests` by whether a file calls `mock.module`.
 *
 * `mock.module` is process-global, has no teardown, and `mock.restore()` cannot
 * undo it once the real module has been loaded. `bun test --parallel` runs files
 * concurrently *in one process*, so a stub installed by one file is visible to
 * every other file that imports the same specifier — and which file wins is a
 * race, not an order. That race is not theoretical: `app-agent-model.test.ts`
 * passed locally and failed in CI because four files stub
 * `agents/profiles/index.js` with a `buildAppAgentProfile` that returns no
 * `model`.
 *
 * So: files that mock get one process each (a stub cannot outlive its process),
 * and everything else shares one `--parallel` process. Isolated files still run
 * concurrently with each other — separate processes, so no leak — which keeps
 * the wall-clock close to the single-process run.
 *
 * The partition is computed from the source on every run. There is no list to
 * keep in sync: add a `mock.module` to a file and it is isolated automatically.
 */

import { Glob } from 'bun';

/** Isolated processes to keep in flight at once. */
const MAX_CONCURRENT = 4;

/**
 * Preload run (and awaited) before any test file loads in a spawned process.
 * `materialize-app-protocols` rebuilds the `dist/protocol.json` fixtures a few
 * tests read, before the first `listApps()` caches an empty manifest — which a
 * per-file `beforeAll` cannot guarantee in the shared `--parallel` process.
 */
const PRELOAD = ['--preload', './src/tests/setup/materialize-app-protocols.ts'];

/**
 * Does this file install a module mock?
 *
 * Comment lines are dropped first — several files *discuss* `mock.module` in
 * prose (the loopback harness explains at length why it does not use one), and
 * counting those would isolate files that never mock anything.
 */
function installsModuleMock(source: string): boolean {
  const code = source
    .split('\n')
    .filter((line) => {
      const t = line.trimStart();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
  return /\bmock\.module\s*\(/.test(code);
}

async function run(args: string[], label: string): Promise<boolean> {
  const proc = Bun.spawn(['bun', 'test', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // Bun writes test results to stderr; print both under one header so concurrent
  // children stay readable instead of interleaving line by line.
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

const glob = new Glob('src/tests/**/*.test.ts');
const all: string[] = [];
for await (const file of glob.scan('.')) {
  if (file.includes('/loopback/')) continue; // own suite, own process
  all.push(file);
}
all.sort();

const mocking: string[] = [];
const pure: string[] = [];
for (const file of all) {
  (installsModuleMock(await Bun.file(file).text()) ? mocking : pure).push(file);
}

console.log(
  `[units] ${pure.length} file(s) shared --parallel process, ` +
    `${mocking.length} isolated (installs mock.module)`,
);

const outcomes = await pooled(
  [
    () => run([...PRELOAD, ...pure, '--parallel'], `shared (${pure.length} files)`),
    ...mocking.map((file) => () => run([...PRELOAD, file], `isolated: ${file}`)),
  ],
  MAX_CONCURRENT,
);

const failed = outcomes.filter((ok) => !ok).length;
if (failed > 0) {
  console.error(`\n[units] ${failed} of ${outcomes.length} test process(es) failed`);
  process.exit(1);
}
console.log(`\n[units] all ${outcomes.length} test process(es) passed`);
