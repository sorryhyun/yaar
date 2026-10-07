/**
 * `@bundled/test` — the runtime an app's `*.test.ts` files run on.
 *
 * Imported directly: the shim is plain code over `performance`, `setTimeout` and
 * promises, so its behavior does not need a browser to be pinned down. That the
 * page wiring around it works in one is `compile-tests.test.ts`'s job.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import * as T from '../shims/test.js';

beforeEach(() => T.__reset());

/** Register under a file, the way the generated entry does. */
function file(name: string, body: () => void): void {
  T.__setFile(name);
  body();
}

describe('running', () => {
  test('passes, failures and file attribution', async () => {
    file('a.test.ts', () => {
      T.describe('math', () => {
        T.test('adds', () => T.expect(1 + 1).toBe(2));
        T.test('breaks', () => T.expect(1 + 1).toBe(3));
      });
    });
    file('b.test.ts', () =>
      T.test('async', async () => T.expect(await Promise.resolve(4)).toBe(4)),
    );
    const run = await T.__run();
    expect(run.pass).toBe(false);
    expect([run.passed, run.failed, run.skipped]).toEqual([2, 1, 0]);
    const broke = run.tests.find((t) => t.status === 'fail')!;
    expect(broke.name).toBe('math > breaks');
    expect(broke.file).toBe('a.test.ts');
    expect(broke.error).toContain('Expected 2 to be 3');
  });

  test('a run with zero tests does not pass', async () => {
    file('empty.test.ts', () => {});
    expect((await T.__run()).pass).toBe(false);
  });

  test('only focuses, skip and todo skip, filter narrows', async () => {
    file('a.test.ts', () => {
      T.test('plain', () => {});
      T.test.only('focused', () => {});
      T.describe.only('suite', () => T.test('inside', () => {}));
      T.test.skip('skipped', () => {});
      T.test.todo('later');
    });
    const run = await T.__run();
    expect(run.tests.filter((t) => t.status === 'pass').map((t) => t.name)).toEqual([
      'focused',
      'suite > inside',
    ]);
    expect(run.skipped).toBe(3);
    const filtered = await T.__run({ filter: 'INSIDE' });
    expect(filtered.tests.map((t) => t.name)).toEqual(['suite > inside']);
  });

  test('hooks run outer-first before, inner-first after, and after runs on failure', async () => {
    const log: string[] = [];
    file('h.test.ts', () => {
      T.beforeEach(() => void log.push('outer-before'));
      T.afterEach(() => void log.push('outer-after'));
      T.describe('inner', () => {
        T.beforeEach(() => void log.push('inner-before'));
        T.afterEach(() => void log.push('inner-after'));
        T.test('fails', () => {
          log.push('body');
          throw new Error('x');
        });
      });
    });
    await T.__run();
    expect(log).toEqual(['outer-before', 'inner-before', 'body', 'inner-after', 'outer-after']);
  });

  test('file-level hooks do not leak into the next file', async () => {
    const log: string[] = [];
    file('a.test.ts', () => T.beforeEach(() => void log.push('a-hook')));
    file('b.test.ts', () => T.test('b', () => {}));
    await T.__run();
    expect(log).toEqual([]);
  });

  test('a hung async test times out', async () => {
    file('t.test.ts', () => T.test('hangs', () => new Promise(() => {}), 20));
    const run = await T.__run();
    expect(run.tests[0]!.error).toContain('Timed out after 20ms');
  });

  test('an async describe callback is an error, not a silent empty suite', () => {
    T.__setFile('d.test.ts');
    expect(() => T.describe('async', (async () => {}) as unknown as () => void)).toThrow(
      'must be synchronous',
    );
  });
});

describe('expect', () => {
  const fails = (fn: () => void) => expect(fn).toThrow(T.AssertionError);

  test('equality', () => {
    T.expect({ a: [1, { b: 2 }], u: undefined }).toEqual({ a: [1, { b: 2 }] });
    T.expect(new Map([[1, new Set(['x'])]])).toEqual(new Map([[1, new Set(['x'])]]));
    T.expect(new Date(5)).toEqual(new Date(5));
    T.expect(NaN).toBe(NaN);
    fails(() => T.expect({ a: 1 }).toEqual({ a: 2 }));
    fails(() => T.expect([1, 2]).toEqual([1, 2, 3]));
    fails(() => T.expect({}).toBe({}));
    T.expect({ a: 1, b: { c: 2, d: 3 } }).toMatchObject({ b: { c: 2 } });
  });

  test('not, and the message names what was expected', () => {
    T.expect(1).not.toBe(2);
    expect(() => T.expect(1).not.toBe(1)).toThrow('Expected not 1 to be 1');
  });

  test('collections, strings and numbers', () => {
    T.expect('hello').toContain('ell');
    T.expect([1, 2]).toContain(2);
    T.expect(new Set([3])).toContain(3);
    T.expect([{ a: 1 }]).toContainEqual({ a: 1 });
    T.expect('abc').toHaveLength(3);
    T.expect({ a: { b: 1 } }).toHaveProperty('a.b', 1);
    fails(() => T.expect({ a: {} }).toHaveProperty('a.b'));
    T.expect('2026-10-07').toMatch(/^\d{4}-/);
    T.expect(0.1 + 0.2).toBeCloseTo(0.3);
    T.expect(3).toBeGreaterThan(2);
    T.expect(null).toBeNull();
    T.expect(undefined).toBeUndefined();
    T.expect(new RangeError('r')).toBeInstanceOf(Error);
  });

  test('toThrow by substring, RegExp and class', () => {
    const boom = () => {
      throw new RangeError('out of range');
    };
    T.expect(boom).toThrow();
    T.expect(boom).toThrow('of range');
    T.expect(boom).toThrow(/^out/);
    T.expect(boom).toThrow(RangeError);
    fails(() => T.expect(boom).toThrow(TypeError));
    fails(() => T.expect(() => {}).toThrow());
  });

  test('resolves and rejects', async () => {
    await T.expect(Promise.resolve(2)).resolves.toBe(2);
    await T.expect(Promise.reject(new Error('nope'))).rejects.toThrow('nope');
    await expect(T.expect(Promise.resolve(1)).rejects.toThrow()).rejects.toThrow(
      'Expected promise to reject',
    );
  });
});

describe('report', () => {
  test('is compact: per-file counts and failures, not every passing name', async () => {
    file('a.test.ts', () => {
      for (let i = 0; i < 30; i++) T.test(`fails ${i}`, () => T.expect(i).toBe(-1));
      T.test('passes', () => {});
    });
    T.__loadError('broken.test.ts', new Error('import failed'));
    const report = T.__summarize(await T.__run());
    expect(report.files).toEqual([{ file: 'a.test.ts', passed: 1, failed: 30, skipped: 0 }]);
    expect(report.failures).toHaveLength(25);
    expect(report.failuresOmitted).toBe(5);
    expect(report.tests).toBeUndefined();
    expect(report.loadErrors[0]!.file).toBe('broken.test.ts');
    expect(report.pass).toBe(false);
    expect(JSON.stringify(report).length).toBeLessThan(16_384);
    expect(T.__summarize(await T.__run(), { verbose: true }).tests).toHaveLength(31);
  });
});
