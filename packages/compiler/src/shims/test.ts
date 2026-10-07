// @ts-nocheck — This file runs in browser iframes, not the server (the compiler's
// tsconfig has no DOM lib, and a test imports this file directly).
/**
 * `@bundled/test` — the test API for an app's `*.test.ts` files.
 *
 * Before this, an agent that wanted tests wrote its own harness, imported the
 * test files from `main.ts` and exposed them through `debug`, so every test
 * shipped in the deployed bundle. Tests now live beside the code as
 * `src/**\/*.test.ts`, the compiler builds them into a separate test page
 * (`compileTests`), and Dev Tools' `runTests` loads that page in the preview and
 * reads back `__yaar_tests__.run()`. The app build refuses this module, so test
 * code cannot reach a deployed app by accident.
 *
 * The surface is a small subset of `bun:test` (describe / test / it / expect /
 * beforeEach / afterEach), so code an agent writes from habit runs unchanged.
 * Tests run in the browser, in the preview's sandbox: DOM, `@bundled/yaar` and
 * app storage are all real. A test that never returns (an infinite loop, a
 * catastrophic regex) cannot be timed out from inside the page; the caller's
 * own timeout is the backstop.
 */

const DEFAULT_TIMEOUT_MS = 5_000;

interface Suite {
  name: string;
  skip: boolean;
  only: boolean;
  beforeEach: Array<() => unknown>;
  afterEach: Array<() => unknown>;
  parent: Suite | null;
}

interface Case {
  name: string;
  file: string;
  fn: () => unknown;
  suite: Suite;
  skip: boolean;
  only: boolean;
  timeoutMs: number;
}

export interface TestCaseResult {
  /** `describe` names and the test name, joined with ` > `. */
  name: string;
  /** The test file, relative to `src/`. */
  file: string;
  status: 'pass' | 'fail' | 'skip';
  durationMs: number;
  error?: string;
}

export interface TestRunResult {
  pass: boolean;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  files: string[];
  tests: TestCaseResult[];
  /** Thrown while a test file was loading — every test in that file is missing. */
  loadErrors: Array<{ file: string; error: string }>;
}

const root: Suite = {
  name: '',
  skip: false,
  only: false,
  beforeEach: [],
  afterEach: [],
  parent: null,
};
let current: Suite = root;
let currentFile = '';
const cases: Case[] = [];
const files: string[] = [];
const loadErrors: Array<{ file: string; error: string }> = [];

function errorText(err: unknown): string {
  if (err instanceof Error)
    return err.stack && err.stack.includes(err.message) ? err.stack : `${err.name}: ${err.message}`;
  return `Thrown non-error: ${format(err)}`;
}

// ── Registration ────────────────────────────────────────────────

function addSuite(name: string, fn: () => void, flags: { skip?: boolean; only?: boolean }): void {
  const suite: Suite = {
    name,
    skip: !!flags.skip,
    only: !!flags.only,
    beforeEach: [],
    afterEach: [],
    parent: current,
  };
  const outer = current;
  current = suite;
  try {
    const out = fn();
    if (out && typeof (out as Promise<unknown>).then === 'function') {
      throw new Error(
        `describe("${name}") callback must be synchronous; register tests, then await inside them.`,
      );
    }
  } finally {
    current = outer;
  }
}

function addCase(
  name: string,
  fn: () => unknown,
  timeoutMs: number | undefined,
  flags: { skip?: boolean; only?: boolean },
): void {
  cases.push({
    name,
    file: currentFile,
    fn,
    suite: current,
    skip: !!flags.skip,
    only: !!flags.only,
    timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
}

type DescribeFn = ((name: string, fn: () => void) => void) & {
  skip: (name: string, fn: () => void) => void;
  only: (name: string, fn: () => void) => void;
};
type TestFn = ((name: string, fn: () => unknown, timeoutMs?: number) => void) & {
  skip: (name: string, fn: () => unknown, timeoutMs?: number) => void;
  only: (name: string, fn: () => unknown, timeoutMs?: number) => void;
  todo: (name: string) => void;
};

export const describe: DescribeFn = Object.assign(
  (name: string, fn: () => void) => addSuite(name, fn, {}),
  {
    skip: (name: string, fn: () => void) => addSuite(name, fn, { skip: true }),
    only: (name: string, fn: () => void) => addSuite(name, fn, { only: true }),
  },
);

export const test: TestFn = Object.assign(
  (name: string, fn: () => unknown, timeoutMs?: number) => addCase(name, fn, timeoutMs, {}),
  {
    skip: (name: string, fn: () => unknown, timeoutMs?: number) =>
      addCase(name, fn, timeoutMs, { skip: true }),
    only: (name: string, fn: () => unknown, timeoutMs?: number) =>
      addCase(name, fn, timeoutMs, { only: true }),
    todo: (name: string) => addCase(name, () => {}, undefined, { skip: true }),
  },
);

export const it = test;

export function beforeEach(fn: () => unknown): void {
  current.beforeEach.push(fn);
}

export function afterEach(fn: () => unknown): void {
  current.afterEach.push(fn);
}

// ── Running ─────────────────────────────────────────────────────

function chain(suite: Suite): Suite[] {
  const out: Suite[] = [];
  for (let s: Suite | null = suite; s; s = s.parent) out.unshift(s);
  return out;
}

function fullName(c: Case): string {
  return [
    ...chain(c.suite)
      .map((s) => s.name)
      .filter(Boolean),
    c.name,
  ].join(' > ');
}

async function withTimeout(fn: () => unknown, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface RunOptions {
  /** Only tests whose full name or file contains this text (case-insensitive). */
  filter?: string;
}

/** Run every registered test, sequentially, in registration order. */
export async function __run(options: RunOptions = {}): Promise<TestRunResult> {
  const started = performance.now();
  const filter = options.filter?.toLowerCase();
  const anyOnly = cases.some((c) => c.only || chain(c.suite).some((s) => s.only));
  const tests: TestCaseResult[] = [];

  for (const c of cases) {
    const name = fullName(c);
    if (filter && !name.toLowerCase().includes(filter) && !c.file.toLowerCase().includes(filter)) {
      continue;
    }
    const suites = chain(c.suite);
    const focused = c.only || suites.some((s) => s.only);
    if (c.skip || suites.some((s) => s.skip) || (anyOnly && !focused)) {
      tests.push({ name, file: c.file, status: 'skip', durationMs: 0 });
      continue;
    }

    const t0 = performance.now();
    let error: unknown;
    try {
      for (const s of suites) for (const hook of s.beforeEach) await hook();
      await withTimeout(c.fn, c.timeoutMs);
    } catch (err) {
      error = err;
    }
    // afterEach runs even when the test failed, innermost first.
    for (const s of [...suites].reverse()) {
      for (const hook of s.afterEach) {
        try {
          await hook();
        } catch (err) {
          error ??= err;
        }
      }
    }
    const durationMs = Math.round((performance.now() - t0) * 10) / 10;
    tests.push(
      error === undefined
        ? { name, file: c.file, status: 'pass', durationMs }
        : { name, file: c.file, status: 'fail', durationMs, error: errorText(error) },
    );
  }

  const passed = tests.filter((t) => t.status === 'pass').length;
  const failed = tests.filter((t) => t.status === 'fail').length;
  const skipped = tests.filter((t) => t.status === 'skip').length;
  return {
    pass: failed === 0 && loadErrors.length === 0 && passed > 0,
    total: tests.length,
    passed,
    failed,
    skipped,
    durationMs: Math.round(performance.now() - started),
    files: [...files],
    tests,
    loadErrors: [...loadErrors],
  };
}

export interface TestReport {
  pass: boolean;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  files: Array<{ file: string; passed: number; failed: number; skipped: number }>;
  /** The first {@link MAX_REPORTED_FAILURES}, each error cut to {@link MAX_ERROR_CHARS}. */
  failures: Array<{ name: string; file: string; error: string }>;
  failuresOmitted?: number;
  loadErrors: Array<{ file: string; error: string }>;
  /** Every test with its status — only when asked for (`verbose`). */
  tests?: Array<{
    name: string;
    file: string;
    status: TestCaseResult['status'];
    durationMs: number;
  }>;
}

const MAX_REPORTED_FAILURES = 25;
const MAX_ERROR_CHARS = 1_500;

const clip = (text: string) =>
  text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}... [truncated]` : text;

/**
 * A run cut to what fits the caller's channel. Dev Tools reads it through
 * `app_eval`, whose reply is capped at 16KB: per-file counts and the failures
 * are what a fix needs; the full list of passing names is opt-in.
 */
export function __summarize(
  result: TestRunResult,
  options: { verbose?: boolean } = {},
): TestReport {
  const byFile = new Map<
    string,
    { file: string; passed: number; failed: number; skipped: number }
  >();
  for (const file of result.files) byFile.set(file, { file, passed: 0, failed: 0, skipped: 0 });
  for (const t of result.tests) {
    const row = byFile.get(t.file) ?? { file: t.file, passed: 0, failed: 0, skipped: 0 };
    byFile.set(t.file, row);
    if (t.status === 'pass') row.passed++;
    else if (t.status === 'fail') row.failed++;
    else row.skipped++;
  }
  const failing = result.tests.filter((t) => t.status === 'fail');
  return {
    pass: result.pass,
    total: result.total,
    passed: result.passed,
    failed: result.failed,
    skipped: result.skipped,
    durationMs: result.durationMs,
    files: [...byFile.values()],
    failures: failing
      .slice(0, MAX_REPORTED_FAILURES)
      .map((t) => ({ name: t.name, file: t.file, error: clip(t.error ?? '') })),
    ...(failing.length > MAX_REPORTED_FAILURES
      ? { failuresOmitted: failing.length - MAX_REPORTED_FAILURES }
      : {}),
    loadErrors: result.loadErrors.map((e) => ({ file: e.file, error: clip(e.error) })),
    ...(options.verbose
      ? {
          tests: result.tests.map(({ name, file, status, durationMs }) => ({
            name,
            file,
            status,
            durationMs,
          })),
        }
      : {}),
  };
}

/** Called by the generated test entry before each test file's body runs. */
export function __setFile(file: string): void {
  currentFile = file;
  // Each file gets a nameless suite of its own, so a file-level beforeEach
  // applies to that file's tests and not to every file loaded after it.
  current = { name: '', skip: false, only: false, beforeEach: [], afterEach: [], parent: root };
  files.push(file);
}

/** Called by the generated test entry when a test file throws while loading. */
export function __loadError(file: string, err: unknown): void {
  loadErrors.push({ file, error: errorText(err) });
}

/** Forget every registration — for the runtime's own tests. */
export function __reset(): void {
  cases.length = 0;
  files.length = 0;
  loadErrors.length = 0;
  current = root;
  root.beforeEach.length = 0;
  root.afterEach.length = 0;
  currentFile = '';
}

// ── expect ──────────────────────────────────────────────────────

/** Render a value for a failure message: short, and never throwing. */
export function format(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (typeof value === 'symbol' || value === undefined) return String(value);
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (value instanceof RegExp || value instanceof Date) return String(value);
  if (value instanceof Map) return `Map(${format([...value.entries()])})`;
  if (value instanceof Set) return `Set(${format([...value.values()])})`;
  try {
    const seen = new WeakSet<object>();
    const text = JSON.stringify(value, (_key, v) => {
      if (typeof v === 'bigint') return `${v}n`;
      if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
      if (v === undefined) return '<undefined>';
      if (v && typeof v === 'object') {
        if (seen.has(v)) return '[Circular]';
        seen.add(v);
      }
      return v;
    });
    return text.length > 400 ? `${text.slice(0, 400)}...` : text;
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/** Structural equality: plain objects, arrays, Map, Set, Date, RegExp, typed arrays. */
export function equals(a: unknown, b: unknown, seen = new Map<object, object>()): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (seen.get(a) === b) return true;
  seen.set(a, b);

  if (a instanceof Date) return a.getTime() === (b as Date).getTime();
  if (a instanceof RegExp) return String(a) === String(b);
  if (a instanceof Map) {
    const bm = b as Map<unknown, unknown>;
    if (a.size !== bm.size) return false;
    for (const [k, v] of a) if (!bm.has(k) || !equals(v, bm.get(k), seen)) return false;
    return true;
  }
  if (a instanceof Set) {
    const bs = b as Set<unknown>;
    if (a.size !== bs.size) return false;
    outer: for (const v of a) {
      if (bs.has(v)) continue;
      for (const w of bs) if (equals(v, w, seen)) continue outer;
      return false;
    }
    return true;
  }
  if (ArrayBuffer.isView(a)) {
    const av = a as unknown as ArrayLike<unknown>;
    const bv = b as unknown as ArrayLike<unknown>;
    if (av.length !== bv.length) return false;
    for (let i = 0; i < av.length; i++) if (!Object.is(av[i], bv[i])) return false;
    return true;
  }
  if (Array.isArray(a)) {
    const ba = b as unknown[];
    if (a.length !== ba.length) return false;
    for (let i = 0; i < a.length; i++) if (!equals(a[i], ba[i], seen)) return false;
    return true;
  }
  // `undefined`-valued keys count as absent, as in bun:test's toEqual.
  const keys = (o: object) =>
    Object.keys(o).filter((k) => (o as Record<string, unknown>)[k] !== undefined);
  const ak = keys(a);
  const bk = keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!equals((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], seen)) {
      return false;
    }
  }
  return true;
}

/** Every key in `expected` matches in `actual`, recursively; extra keys are fine. */
function matchesObject(actual: unknown, expected: unknown): boolean {
  if (typeof expected !== 'object' || expected === null || Array.isArray(expected)) {
    return equals(actual, expected);
  }
  if (typeof actual !== 'object' || actual === null) return false;
  return Object.entries(expected).every(([k, v]) =>
    matchesObject((actual as Record<string, unknown>)[k], v),
  );
}

export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionError';
  }
}

type Check = (actual: unknown, ...args: unknown[]) => { pass: boolean; message: string };

const MATCHERS: Record<string, Check> = {
  toBe: (a, e) => ({ pass: Object.is(a, e), message: `${format(a)} to be ${format(e)}` }),
  toEqual: (a, e) => ({ pass: equals(a, e), message: `${format(a)} to equal ${format(e)}` }),
  toStrictEqual: (a, e) => ({ pass: equals(a, e), message: `${format(a)} to equal ${format(e)}` }),
  toMatchObject: (a, e) => ({
    pass: matchesObject(a, e),
    message: `${format(a)} to match object ${format(e)}`,
  }),
  toBeTruthy: (a) => ({ pass: !!a, message: `${format(a)} to be truthy` }),
  toBeFalsy: (a) => ({ pass: !a, message: `${format(a)} to be falsy` }),
  toBeNull: (a) => ({ pass: a === null, message: `${format(a)} to be null` }),
  toBeUndefined: (a) => ({ pass: a === undefined, message: `${format(a)} to be undefined` }),
  toBeDefined: (a) => ({ pass: a !== undefined, message: `${format(a)} to be defined` }),
  toBeNaN: (a) => ({ pass: Number.isNaN(a), message: `${format(a)} to be NaN` }),
  toBeInstanceOf: (a, cls) => ({
    pass: a instanceof (cls as new () => unknown),
    message: `${format(a)} to be an instance of ${(cls as { name?: string })?.name}`,
  }),
  toBeGreaterThan: (a, n) => ({
    pass: (a as number) > (n as number),
    message: `${format(a)} to be > ${format(n)}`,
  }),
  toBeGreaterThanOrEqual: (a, n) => ({
    pass: (a as number) >= (n as number),
    message: `${format(a)} to be >= ${format(n)}`,
  }),
  toBeLessThan: (a, n) => ({
    pass: (a as number) < (n as number),
    message: `${format(a)} to be < ${format(n)}`,
  }),
  toBeLessThanOrEqual: (a, n) => ({
    pass: (a as number) <= (n as number),
    message: `${format(a)} to be <= ${format(n)}`,
  }),
  toBeCloseTo: (a, n, digits = 2) => ({
    pass: Math.abs((a as number) - (n as number)) < 10 ** -(digits as number) / 2,
    message: `${format(a)} to be close to ${format(n)} (${digits} digits)`,
  }),
  toContain: (a, item) => ({
    pass:
      typeof a === 'string'
        ? a.includes(item as string)
        : a != null && typeof (a as Iterable<unknown>)[Symbol.iterator] === 'function'
          ? [...(a as Iterable<unknown>)].includes(item)
          : false,
    message: `${format(a)} to contain ${format(item)}`,
  }),
  toContainEqual: (a, item) => ({
    pass: Array.isArray(a) && a.some((x) => equals(x, item)),
    message: `${format(a)} to contain an element equal to ${format(item)}`,
  }),
  toHaveLength: (a, n) => ({
    pass: (a as { length?: number })?.length === n,
    message: `${format(a)} to have length ${n} (has ${(a as { length?: number })?.length})`,
  }),
  toHaveProperty: (a, path, ...rest) => {
    const keys = Array.isArray(path) ? path : String(path).split('.');
    let v: unknown = a;
    let found = true;
    for (const k of keys) {
      if (v == null || !(Object(v) as object).hasOwnProperty.call(Object(v), k)) {
        found = false;
        break;
      }
      v = (v as Record<string, unknown>)[k];
    }
    const pass = found && (rest.length === 0 || equals(v, rest[0]));
    return {
      pass,
      message: `${format(a)} to have property ${keys.join('.')}${rest.length ? ` = ${format(rest[0])}` : ''}`,
    };
  },
  toMatch: (a, re) => ({
    pass: typeof a === 'string' && (re instanceof RegExp ? re.test(a) : a.includes(String(re))),
    message: `${format(a)} to match ${format(re)}`,
  }),
  toThrow: (a, expected) => {
    if (typeof a !== 'function') {
      return { pass: false, message: `${format(a)} to be a function that throws` };
    }
    let thrown: unknown;
    let threw = false;
    try {
      a();
    } catch (err) {
      threw = true;
      thrown = err;
    }
    return throwResult(threw, thrown, expected);
  },
};

function throwResult(threw: boolean, thrown: unknown, expected: unknown) {
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  let pass = threw;
  if (threw && expected !== undefined) {
    if (typeof expected === 'string') pass = message.includes(expected);
    else if (expected instanceof RegExp) pass = expected.test(message);
    else if (typeof expected === 'function')
      pass = thrown instanceof (expected as new () => unknown);
    else if (expected instanceof Error) pass = message === expected.message;
  }
  const want = expected === undefined ? '' : ` matching ${format(expected)}`;
  const got = threw ? ` (threw ${format(thrown)})` : ' (did not throw)';
  return { pass, message: `function to throw${want}${got}` };
}

type Matchers = {
  [K in keyof typeof MATCHERS]: (...args: unknown[]) => void;
} & { toThrow: (expected?: unknown) => void };
type AsyncMatchers = { [K in keyof Matchers]: (...args: unknown[]) => Promise<void> };

export interface Expectation extends Matchers {
  not: Matchers;
  resolves: AsyncMatchers & { not: AsyncMatchers };
  rejects: AsyncMatchers & { not: AsyncMatchers };
}

type Mode = 'sync' | 'resolves' | 'rejects';

function bind(actual: () => unknown, negate: boolean, mode: Mode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, check] of Object.entries(MATCHERS)) {
    const assert = (value: unknown, args: unknown[]) => {
      // `rejects.toThrow(x)` checks the rejection reason as if it had been thrown.
      const { pass, message } =
        name === 'toThrow' && mode === 'rejects'
          ? throwResult(true, value, args[0])
          : check(value, ...args);
      if (pass === negate) {
        throw new AssertionError(`Expected ${negate ? 'not ' : ''}${message}`);
      }
    };
    out[name] =
      mode !== 'sync'
        ? async (...args: unknown[]) => assert(await actual(), args)
        : (...args: unknown[]) => assert(actual(), args);
  }
  return out;
}

export function expect(actual: unknown): Expectation {
  const now = () => actual;
  const resolved = async () => {
    try {
      return await actual;
    } catch (err) {
      throw new AssertionError(`Expected promise to resolve, but it rejected with ${format(err)}`);
    }
  };
  const rejected = async () => {
    try {
      await actual;
    } catch (err) {
      return err;
    }
    throw new AssertionError('Expected promise to reject, but it resolved');
  };
  return {
    ...bind(now, false, 'sync'),
    not: bind(now, true, 'sync'),
    resolves: { ...bind(resolved, false, 'resolves'), not: bind(resolved, true, 'resolves') },
    rejects: { ...bind(rejected, false, 'rejects'), not: bind(rejected, true, 'rejects') },
  } as unknown as Expectation;
}
