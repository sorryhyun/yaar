/**
 * Benchmarks for sandbox JS/TS code execution.
 *
 * The sandbox runs every `run_js` MCP call and every app deployed via the dev
 * tools.  Each call creates a fresh vm.Context, compiles the code, and awaits
 * the result — so the per-call overhead directly impacts AI tool latency.
 *
 * wrapCodeForExecution() is benchmarked separately because it is a pure-string
 * transform called synchronously before the VM is involved; regressions there
 * add latency to every sandbox invocation.
 *
 * Run with: bun run --filter @yaar/tests bench
 */

import { bench, describe } from 'vitest';
import { executeJs, executeTs } from '@yaar/server/lib/sandbox/index';
import { wrapCodeForExecution } from '@yaar/server/lib/sandbox/transform';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const CODE_SIMPLE = 'return 42';

const CODE_ARRAY_OPS = `
  const arr = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5];
  const sorted = arr.slice().sort((a, b) => a - b);
  return sorted.reduce((sum, n) => sum + n, 0);
`;

const CODE_STRING_OPS = `
  const text = "The quick brown fox jumps over the lazy dog in the sandbox environment";
  const words = text.toLowerCase().split(/\\s+/);
  const unique = [...new Set(words)].sort();
  return unique.join(', ');
`;

const CODE_MAP_REDUCE = `
  const data = Array.from({ length: 50 }, (_, i) => ({ id: i, value: i * i }));
  const result = data
    .filter(d => d.value > 100)
    .map(d => ({ ...d, label: String(d.id).padStart(3, '0') }))
    .reduce((acc, d) => { acc[d.label] = d.value; return acc; }, {});
  return Object.keys(result).length;
`;

const CODE_TS_SIMPLE = `
  const add = (a: number, b: number): number => a + b;
  return add(40, 2);
`;

const CODE_TS_INTERFACE = `
  interface DataPoint { label: string; value: number; }
  const points: DataPoint[] = [
    { label: 'Q1', value: 120 },
    { label: 'Q2', value: 135 },
    { label: 'Q3', value: 98 },
    { label: 'Q4', value: 162 },
  ];
  return points.reduce((max, p) => (p.value > max.value ? p : max)).label;
`;

// ── wrapCodeForExecution (pure string transform, no VM) ───────────────────────

describe('wrapCodeForExecution', () => {
  bench('simple bare expression', () => {
    wrapCodeForExecution('42');
  });

  bench('explicit return statement', () => {
    wrapCodeForExecution('return 42');
  });

  bench('multi-statement with auto-return', () => {
    wrapCodeForExecution(`
      const arr = [3, 1, 4, 1, 5];
      arr.sort((a, b) => a - b);
      arr.reduce((s, n) => s + n, 0)
    `);
  });

  bench('long code with nested braces', () => {
    wrapCodeForExecution(CODE_MAP_REDUCE);
  });
});

// ── executeJs (creates a fresh vm.Context each call) ─────────────────────────

describe('executeJs', () => {
  bench('simple expression: return 42', async () => {
    await executeJs(CODE_SIMPLE);
  });

  bench('array sort + reduce (11 elements)', async () => {
    await executeJs(CODE_ARRAY_OPS);
  });

  bench('string split + dedup + sort', async () => {
    await executeJs(CODE_STRING_OPS);
  });

  bench('filter/map/reduce over 50-element array', async () => {
    await executeJs(CODE_MAP_REDUCE);
  });
});

// ── executeTs (TypeScript compilation + VM) ───────────────────────────────────

describe('executeTs', () => {
  bench('simple typed addition function', async () => {
    await executeTs(CODE_TS_SIMPLE);
  });

  bench('interface + array reduce', async () => {
    await executeTs(CODE_TS_INTERFACE);
  });
});
