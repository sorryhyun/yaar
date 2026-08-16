#!/usr/bin/env bun
/**
 * The whole monorepo's tests — one process per package, and one summary at the end.
 *
 * This replaces `bun run --filter '*' test` as the definition of `bun run test`. The
 * filter runner is fine at *running* things and useless at reporting them: it interleaves
 * five packages' output line by line behind `@yaar/x test:` prefixes, and it ends wherever
 * the slowest package happened to end. So `bun run test | tail` showed a stray log line
 * from whichever suite finished last, and answering "did it pass" meant scrolling past
 * ~2000 lines to find five separate verdicts.
 *
 * Two changes, both about the reader:
 *
 *   - **Each package's output is buffered and printed whole**, under its own header, when
 *     it finishes. Same trade the server package's runner already makes
 *     (`packages/server/scripts/run-tests.ts`): you lose live interleaving, you gain
 *     output you can actually read. The packages still run concurrently.
 *   - **The last thing printed is always the summary** — per-package counts, a total, and
 *     on a red run the names of the failing tests. That is the `tail`-able part.
 *
 * It discovers packages by globbing rather than listing them, so a new workspace package
 * with a `test` script is picked up by the run instead of being silently skipped — the
 * same failure the server runner's `src/**` glob exists to prevent, one level up.
 *
 * The exit code is unchanged and remains the real gate: non-zero if any package failed.
 * Every package runs even when an earlier one fails, so a change that breaks two things
 * shows you two.
 */

import { Glob } from 'bun';

import {
  addCounts,
  formatCounts,
  formatDuration,
  parseCounts,
  parseFailures,
  ZERO_COUNTS,
  type TestCounts,
} from './summary.ts';

const ROOT = new URL('../../', import.meta.url).pathname;

interface Pkg {
  name: string;
  dir: string;
}

interface Outcome {
  pkg: Pkg;
  ok: boolean;
  counts: TestCounts;
  failures: string[];
  durationMs: number;
}

async function discover(): Promise<Pkg[]> {
  const glob = new Glob('packages/*/package.json');
  const found: Pkg[] = [];
  for await (const rel of glob.scan(ROOT)) {
    const path = `${ROOT}${rel.replaceAll('\\', '/')}`;
    const manifest = (await Bun.file(path).json()) as {
      name?: string;
      scripts?: Record<string, string>;
    };
    if (!manifest.scripts?.test || !manifest.name) continue;
    found.push({ name: manifest.name, dir: path.slice(0, -'/package.json'.length) });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

async function run(pkg: Pkg): Promise<Outcome> {
  const startedAt = Date.now();
  // `bun run test` rather than `bun test`: the packages' `pretest` hooks build the
  // `dist/` that shared and compiler publish, and several of them ask for the same build
  // at once — which is why `ensure-deps-built.ts` holds a lock.
  const proc = Bun.spawn(['bun', 'run', 'test'], {
    cwd: pkg.dir,
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  // Bun writes test results to stderr and script output to stdout, and the server
  // package's runner emits both; parse and print the pair as one document.
  const output = `${stdout}${stderr}`;
  const durationMs = Date.now() - startedAt;
  const counts = parseCounts(output);
  process.stdout.write(
    `\n═════ ${pkg.name} — ${formatCounts(counts)} in ${formatDuration(durationMs)} ═════\n` +
      output.replace(/\n*$/, '\n'),
  );
  return { pkg, ok: exitCode === 0, counts, failures: parseFailures(output), durationMs };
}

const packages = await discover();
if (packages.length === 0) throw new Error('no workspace package declares a `test` script');

console.log(`[tests] ${packages.length} package(s): ${packages.map((p) => p.name).join(', ')}`);

const startedAt = Date.now();
const outcomes = await Promise.all(packages.map(run));
const wallMs = Date.now() - startedAt;

// ── The summary, which is the whole point of this file ──────────────────────

const total = outcomes.map((o) => o.counts).reduce(addCounts, ZERO_COUNTS);
const failed = outcomes.filter((o) => !o.ok);
const nameWidth = Math.max(...outcomes.map((o) => o.pkg.name.length));

const lines: string[] = ['', '─'.repeat(64), '  TEST SUMMARY'];
for (const o of outcomes) {
  lines.push(
    `  ${o.ok ? '✅' : '❌'} ${o.pkg.name.padEnd(nameWidth)}  ` +
      `${formatCounts(o.counts).padEnd(28)}${formatDuration(o.durationMs).padStart(7)}`,
  );
}
lines.push('─'.repeat(64));
lines.push(
  `  ${formatCounts(total)} — ${total.tests} test(s) across ${total.files} file(s), ` +
    `${packages.length} package(s) in ${formatDuration(wallMs)}`,
);

// The failing test *names*, so a red `tail` says what to open rather than only how bad it
// is. Capped: past a couple of dozen the list stops being a lead and starts being the
// scrollback this file exists to replace, and the count above already carries "how bad".
const SHOWN_FAILURES = 20;
const allFailures = failed.flatMap((o) => o.failures.map((f) => `${o.pkg.name}  ${f}`));
if (allFailures.length > 0) {
  lines.push('', '  Failing tests:');
  for (const f of allFailures.slice(0, SHOWN_FAILURES)) lines.push(`    ✗ ${f}`);
  if (allFailures.length > SHOWN_FAILURES) {
    lines.push(`    … and ${allFailures.length - SHOWN_FAILURES} more`);
  }
}

// A package can exit non-zero having reported no failing case at all — a suite that
// crashed on import, a runner that refused a partition. Saying so is the difference
// between a summary and a lie.
const silent = failed.filter((o) => o.failures.length === 0).map((o) => o.pkg.name);
if (silent.length > 0) {
  lines.push('', `  Exited non-zero with no failing case reported: ${silent.join(', ')}`);
  lines.push('    (a suite that crashed on import, or a runner that refused — read its block above)');
}

lines.push('');
lines.push(
  failed.length === 0
    ? `✅ all ${packages.length} package(s) passed`
    : `❌ ${failed.length} of ${packages.length} package(s) failed: ${failed.map((o) => o.pkg.name).join(', ')}`,
);
lines.push('');

process.stdout.write(lines.join('\n'));
process.exit(failed.length === 0 ? 0 : 1);
