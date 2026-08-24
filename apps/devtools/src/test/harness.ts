export {};

// A unit-test harness small enough to ship inside the app it tests.
//
// There is no unit-test runner in this environment (see agent/docs/regression-testing.md),
// so nothing here runs under `bun test`. The suites are executed in-process by the
// `selfTest` protocol command instead, which is why the harness has to be pure and
// dependency-free: it is bundled by the same build it is checking.

/** One check: a name and a body that throws on failure. */
export interface Check {
  name: string;
  fn: () => void;
}

/** A named group of checks, run in declaration order. */
export interface Suite {
  name: string;
  checks: Check[];
}

export interface Failure {
  suite: string;
  check: string;
  error: string;
}

export interface RunResult {
  pass: boolean;
  passed: number;
  failed: number;
  suites: { name: string; passed: number; failed: number }[];
  failures: Failure[];
}

/** Declare a suite from an object literal, so a check's name is its key. */
export function suite(name: string, checks: Record<string, () => void>): Suite {
  return { name, checks: Object.entries(checks).map(([n, fn]) => ({ name: n, fn })) };
}

/**
 * Stable JSON for comparison and for failure messages: object keys are sorted, so
 * two equal values never differ only by insertion order.
 */
function canonical(value: unknown): string {
  const text = JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v as Record<string, unknown>)
            .sort()
            .map((k) => [k, (v as Record<string, unknown>)[k]]),
        )
      : v,
  );
  // JSON.stringify(undefined) is undefined, not a string.
  return text ?? String(value);
}

/** Deep equality by canonical JSON. Arrays compare order-sensitively. */
export function eq(actual: unknown, expected: unknown, note?: string): void {
  const a = canonical(actual);
  const e = canonical(expected);
  if (a !== e) throw new Error(`${note ? `${note}: ` : ''}expected ${e}, got ${a}`);
}

export function ok(value: unknown, note = 'expected a truthy value'): void {
  if (!value) throw new Error(note);
}

/**
 * Assert that `fn` throws, and that the message contains `substring`.
 *
 * Matching on a substring rather than the whole message on purpose: these messages are
 * read by an agent and get reworded, and a test that pins the wording fails on an
 * improvement to it. Pin the part that identifies *which* failure it is.
 */
export function throwsWith(fn: () => unknown, substring: string, note?: string): void {
  const label = note ? `${note}: ` : '';
  let message: string | null = null;
  try {
    fn();
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  if (message === null) {
    throw new Error(
      `${label}expected a throw containing ${JSON.stringify(substring)}, but nothing was thrown`,
    );
  }
  if (!message.includes(substring)) {
    throw new Error(
      `${label}expected the error to contain ${JSON.stringify(substring)}, got ${JSON.stringify(message)}`,
    );
  }
}

/**
 * Run every suite, or only the one named `only`.
 *
 * Never throws: a failed check is data, because the caller is a protocol command whose
 * whole job is to report which checks failed. A harness that threw would report the
 * first failure and hide every one after it.
 *
 * An `only` that names no suite is reported as a failure rather than as a vacuous pass —
 * a green run over zero checks is the one result that must never be mistaken for a green
 * run over all of them.
 */
export function runSuites(all: Suite[], only?: string): RunResult {
  const selected = only ? all.filter((s) => s.name === only) : all;
  if (only && selected.length === 0) {
    return {
      pass: false,
      passed: 0,
      failed: 0,
      suites: [],
      failures: [
        {
          suite: only,
          check: '(selection)',
          error: `No suite named "${only}". Available: ${all.map((s) => s.name).join(', ')}`,
        },
      ],
    };
  }
  const failures: Failure[] = [];
  const summaries = selected.map((s) => {
    let passed = 0;
    let failed = 0;
    for (const check of s.checks) {
      try {
        check.fn();
        passed++;
      } catch (err) {
        failed++;
        failures.push({
          suite: s.name,
          check: check.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { name: s.name, passed, failed };
  });
  const passed = summaries.reduce((n, s) => n + s.passed, 0);
  const failed = summaries.reduce((n, s) => n + s.failed, 0);
  return { pass: failed === 0, passed, failed, suites: summaries, failures };
}
