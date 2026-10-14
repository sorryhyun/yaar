/**
 * `prepareEvalExpression` — a preview eval written as TypeScript, or with a top-level
 * `await`, runs and answers the value a plain eval would; one that already parses is
 * passed through untouched.
 */
import { describe, it, expect } from 'bun:test';
import { prepareEvalExpression } from '../features/window/eval-source.js';

/** Run the prepared source the way the iframe does: an indirect eval, awaited. */
async function run(expression: string, scope: Record<string, unknown> = {}): Promise<unknown> {
  const g = globalThis as Record<string, unknown>;
  Object.assign(g, scope);
  try {
    return await (0, eval)(prepareEvalExpression(expression));
  } finally {
    for (const key of Object.keys(scope)) delete g[key];
  }
}

describe('prepareEvalExpression', () => {
  it('passes JavaScript through byte for byte', () => {
    for (const js of ['1 + 1', "document.querySelector('a')", 'const x = 1; x', '{a: 1}']) {
      expect(prepareEvalExpression(js)).toBe(js);
    }
  });

  it('strips TypeScript and keeps the completion value', async () => {
    expect(await run('(__probe as { n: number }).n + 1', { __probe: { n: 2 } })).toBe(3);
    expect(await run('__probe!.n', { __probe: { n: 5 } })).toBe(5);
    expect(await run('const x: number = 3; x * 2')).toBe(6);
    // A pure expression must survive the transpile — dead-code elimination drops it.
    expect(await run('<T,>(a: T) => a')).toBeTypeOf('function');
  });

  it('runs a top-level await and answers its value', async () => {
    const scope = { __probeAsync: async () => [1, 2, 3] };
    expect(await run('await __probeAsync()', scope)).toEqual([1, 2, 3]);
    expect(await run('const r = await __probeAsync(); r.length', scope)).toBe(3);
    expect(
      await run('const r: number[] = await __probeAsync();\nr.map((n) => n * 2)', scope),
    ).toEqual([2, 4, 6]);
  });

  it('answers the last expression even when it spans lines', async () => {
    const scope = { __probeAsync: async () => 4 };
    const source = 'const n = await __probeAsync();\nMath.max(\n  n,\n  1,\n)';
    expect(await run(source, scope)).toBe(4);
  });

  it('keeps an explicit return in an awaiting body', async () => {
    const scope = { __probeAsync: async () => 7 };
    expect(await run('const v = await __probeAsync();\nreturn v;', scope)).toBe(7);
  });

  it('leaves what it cannot repair as written, so the iframe reports the real error', () => {
    for (const broken of ['foo(', 'const = 1', 'await (']) {
      expect(prepareEvalExpression(broken)).toBe(broken);
    }
  });
});
