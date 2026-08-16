/**
 * Reading a `bun test` run's own counts back out of its output.
 *
 * The repo's test story is nested — the root runner spawns one process per package, and
 * the server package's runner spawns one process per partition — so a full run emits
 * twenty-odd independent summary blocks and no total. Whoever wants "did it pass, and how
 * much of it ran" had to either scroll or trust the exit code, and `bun run test | tail`
 * showed whichever package happened to finish last.
 *
 * So both runners parse and re-emit. This is the one parser, for the same reason
 * `partitions.ts` is the one partition rule: a second copy would drift, and a *summary*
 * that drifts is worse than none — it reports confidently.
 *
 * Deliberately additive over every block it finds, rather than reading only the last one.
 * A server run's output holds 19 of them and the interesting number is the sum.
 */

/** The counts one or more `bun test` blocks reported. */
export interface TestCounts {
  pass: number;
  fail: number;
  skip: number;
  todo: number;
  /** Tests reported by `Ran N tests across M files.` — 0 when no such line appeared. */
  tests: number;
  files: number;
}

export const ZERO_COUNTS: TestCounts = { pass: 0, fail: 0, skip: 0, todo: 0, tests: 0, files: 0 };

/** `  1243 pass` — bun writes one such line per outcome that occurred. */
const OUTCOME_LINE = /^\s*(\d+)\s+(pass|fail|skip|todo)\s*$/;

/** `Ran 1244 tests across 121 files. [8.15s]` */
const RAN_LINE = /^\s*Ran\s+(\d+)\s+tests?\s+across\s+(\d+)\s+files?\./;

/** A failing test's own line: `(fail) suite > name [0.20ms]`. */
const FAIL_LINE = /^\s*\(fail\)\s+(.*?)\s*$/;

/** The `[0.20ms]` bun appends to a case name — noise in a list of what to go open. */
const TRAILING_TIMING = /\s*\[[\d.]+m?s\]\s*$/;

/**
 * Colour escapes, stripped before anything is matched.
 *
 * Both runners capture through a pipe, where bun writes plain text — but `FORCE_COLOR` in
 * the environment overrides that, and a summary that silently reads zero because the digit
 * arrived wrapped in an escape is exactly the confident-wrong report this file exists to
 * avoid.
 */
const ANSI = /\u001b\[[0-9;]*m/g;

function lines(output: string): string[] {
  return output.replaceAll(ANSI, '').split('\n');
}

/** Sum every `bun test` summary block in `output`. */
export function parseCounts(output: string): TestCounts {
  const counts: TestCounts = { ...ZERO_COUNTS };
  for (const line of lines(output)) {
    const outcome = OUTCOME_LINE.exec(line);
    if (outcome) {
      counts[outcome[2] as 'pass' | 'fail' | 'skip' | 'todo'] += Number(outcome[1]);
      continue;
    }
    const ran = RAN_LINE.exec(line);
    if (ran) {
      counts.tests += Number(ran[1]);
      counts.files += Number(ran[2]);
    }
  }
  return counts;
}

/**
 * The names of the tests that failed.
 *
 * What a summary is *for* on a red run: the counts say how bad it is, these say what to
 * open. Deduplicated because a file that fails to load reports its cases more than once.
 */
export function parseFailures(output: string): string[] {
  const names = new Set<string>();
  for (const line of lines(output)) {
    const match = FAIL_LINE.exec(line);
    if (match?.[1]) names.add(match[1].replace(TRAILING_TIMING, ''));
  }
  return [...names];
}

export function addCounts(a: TestCounts, b: TestCounts): TestCounts {
  return {
    pass: a.pass + b.pass,
    fail: a.fail + b.fail,
    skip: a.skip + b.skip,
    todo: a.todo + b.todo,
    tests: a.tests + b.tests,
    files: a.files + b.files,
  };
}

/**
 * `1243 pass, 1 skip` — the outcomes that actually occurred, in a fixed order.
 *
 * Zeroes are dropped, with one exception: `0 fail` is always shown, because "no failures"
 * is the fact the reader came for and its absence reads as a truncated line rather than a
 * clean run.
 */
export function formatCounts(c: TestCounts): string {
  const parts = [`${c.pass} pass`, `${c.fail} fail`];
  if (c.skip > 0) parts.push(`${c.skip} skip`);
  if (c.todo > 0) parts.push(`${c.todo} todo`);
  return parts.join(', ');
}

/** `8.2s` / `410ms` — a duration a human reads at a glance rather than parses. */
export function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}
