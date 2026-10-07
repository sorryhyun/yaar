/**
 * `compileTests` — a project's `src/**\/*.test.ts` built into `dist/test.html`.
 *
 * The page's module script is run here in Bun with `window` aliased to the global:
 * the generated entry only touches `window.__yaar_tests__`, and the runtime is
 * plain code. So these cases exercise the real wiring — dynamic per-file loading,
 * file attribution, a file that throws while loading — without a browser.
 */
import { afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { initCompiler } from '../config.js';
import { compileTests, compileTypeScript, listTestFiles, TEST_OUTPUT_FILE } from '../compile.js';

setDefaultTimeout(30_000);

beforeAll(() => {
  initCompiler({ projectRoot: resolve(import.meta.dir, '../../../..'), isBundledExe: false });
});

let sandbox: string | null = null;

afterEach(async () => {
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
  sandbox = null;
  delete (globalThis as Record<string, unknown>).__yaar_tests__;
});

async function makeSandbox(files: Record<string, string>): Promise<string> {
  sandbox = await mkdtemp(join(tmpdir(), 'yaar-tests-'));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(sandbox, path, '..'), { recursive: true });
    await Bun.write(join(sandbox, path), text);
  }
  return sandbox;
}

interface Report {
  pass: boolean;
  passed: number;
  failed: number;
  files: Array<{ file: string; passed: number; failed: number; skipped: number }>;
  failures: Array<{ name: string; file: string; error: string }>;
  loadErrors: Array<{ file: string; error: string }>;
}

/** Load the built page's module script and run its tests. */
async function runPage(dir: string): Promise<Report> {
  const html = await Bun.file(join(dir, 'dist', TEST_OUTPUT_FILE)).text();
  const match = html.match(/<script type="module">\n([\s\S]*)\n<\/script>\n<\/body>/);
  expect(match).not.toBeNull();
  const modulePath = join(dir, 'page.mjs');
  await Bun.write(modulePath, match![1]!);
  (globalThis as Record<string, unknown>).window = globalThis;
  await import(modulePath);
  const api = (globalThis as unknown as { __yaar_tests__: { run: () => Promise<Report> } })
    .__yaar_tests__;
  return api.run();
}

const MATH = `export const square = (n: number) => n * n;\n`;
const MAIN = `import { square } from './math';\nexport const app = square(2);\n`;

describe('compileTests', () => {
  test('builds the test files into test.html, runs them, and leaves the app build alone', async () => {
    const dir = await makeSandbox({
      'src/main.ts': MAIN,
      'src/math.ts': MATH,
      'src/math.test.ts': `import { describe, test, expect } from '@bundled/test';
import { square } from './math';
describe('square', () => {
  test('squares', () => expect(square(3)).toBe(9));
  test('is wrong on purpose', () => expect(square(2)).toBe(5));
});
`,
      'src/nested/z.test.ts': `import { test, expect } from '@bundled/test';\ntest('z', () => expect(1).toBe(1));\n`,
    });
    const result = await compileTests(dir);
    expect(result.errors ?? []).toEqual([]);
    expect(result.success).toBe(true);
    expect(result.files).toEqual(['math.test.ts', 'nested/z.test.ts']);
    // Deploy ships dist/index.html; a test build must never write it.
    expect(existsSync(join(dir, 'dist', 'index.html'))).toBe(false);
    // The generated entry is scratch, not something the project keeps.
    expect(existsSync(join(dir, 'dist', '.yaar-test'))).toBe(false);

    const report = await runPage(dir);
    expect(report.pass).toBe(false);
    expect(report.files).toEqual([
      { file: 'math.test.ts', passed: 1, failed: 1, skipped: 0 },
      { file: 'nested/z.test.ts', passed: 1, failed: 0, skipped: 0 },
    ]);
    expect(report.failures[0]!.name).toBe('square > is wrong on purpose');
    expect(report.failures[0]!.error).toContain('Expected 4 to be 5');
  });

  test('a test file that throws while loading is reported by name; the others still run', async () => {
    const dir = await makeSandbox({
      'src/main.ts': MAIN,
      'src/a.test.ts': `import { test, expect } from '@bundled/test';\ntest('a', () => expect(1).toBe(1));\n`,
      'src/b.test.ts': `throw new Error('b blew up at load');\n`,
    });
    expect((await compileTests(dir)).success).toBe(true);
    const report = await runPage(dir);
    expect(report.passed).toBe(1);
    expect(report.loadErrors.map((e) => e.file)).toEqual(['b.test.ts']);
    expect(report.loadErrors[0]!.error).toContain('b blew up at load');
    expect(report.pass).toBe(false);
  });

  test('code under test can start a ?worker', async () => {
    const dir = await makeSandbox({
      'src/main.ts': MAIN,
      'src/math.ts': MATH,
      'src/square.worker.ts': `import { square } from './math';\nself.onmessage = (e: MessageEvent<number>) => self.postMessage(square(e.data));\n`,
      'src/remote.ts': `import SquareWorker from './square.worker.ts?worker';
export const remoteSquare = (n: number) => new Promise<number>((done) => {
  const w = new SquareWorker();
  w.onmessage = (e) => { w.terminate(); done(e.data); };
  w.postMessage(n);
});
`,
      'src/remote.test.ts': `import { test, expect } from '@bundled/test';
import { remoteSquare } from './remote';
test('squares off the main thread', async () => expect(await remoteSquare(6)).toBe(36));
`,
    });
    expect((await compileTests(dir)).errors ?? []).toEqual([]);
    const report = await runPage(dir);
    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(1);
  });

  test('no test files is a clear failure, not an empty pass', async () => {
    const dir = await makeSandbox({ 'src/main.ts': MAIN });
    const result = await compileTests(dir);
    expect(result.success).toBe(false);
    expect(result.errors![0]).toContain('No test files found');
    expect(await listTestFiles(dir)).toEqual([]);
  });

  test('a compile error in a test file is reported with its position', async () => {
    const dir = await makeSandbox({
      'src/main.ts': MAIN,
      'src/bad.test.ts': `import { nothing } from './missing';\nnothing();\n`,
    });
    const result = await compileTests(dir);
    expect(result.success).toBe(false);
    expect(result.errors!.join('\n')).toMatch(/bad\.test\.ts:1:\d+/);
  });
});

describe('the app build', () => {
  test('refuses @bundled/test, so test code cannot ship', async () => {
    const dir = await makeSandbox({
      'src/main.ts': `import { expect } from '@bundled/test';\nexport const e = expect;\n`,
    });
    const result = await compileTypeScript(dir, { minify: false });
    expect(result.success).toBe(false);
    expect(result.errors!.join('\n')).toContain('only importable from src/**/*.test.ts');
  });

  test('ignores test files that main never imports', async () => {
    const dir = await makeSandbox({
      'src/main.ts': MAIN,
      'src/math.ts': MATH,
      'src/math.test.ts': `import { test } from '@bundled/test';\ntest('MARKER_ONLY_IN_TESTS', () => {});\n`,
    });
    const result = await compileTypeScript(dir, { minify: false });
    expect(result.errors ?? []).toEqual([]);
    expect(await Bun.file(result.outputPath!).text()).not.toContain('MARKER_ONLY_IN_TESTS');
  });
});
