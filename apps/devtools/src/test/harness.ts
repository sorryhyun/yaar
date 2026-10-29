export {};

// The assertions Dev Tools' own suites are written in. They run through `test/run`
// (`lib-suites.test.ts` turns each suite into `@bundled/test` cases), so a devtools
// clone is tested as it stands, before its deploy — not the installed build.

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
