/**
 * `import W from './x.worker.ts?worker'` — a worker that ships inside the one HTML file.
 *
 * The case that matters runs the bundle: a worker built from a module that imports
 * a helper is exactly what hand-stringified workers got wrong (the helper was not
 * in the string), so "the build succeeded" is not the claim. Bun has `Worker`,
 * `Blob` and `URL.createObjectURL`, which is all the generated factory uses.
 */
import { afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { initCompiler } from '../config.js';
import { compileTypeScript } from '../compile.js';
import { buildAppBundle } from '../build/build-app.js';

setDefaultTimeout(30_000);

beforeAll(() => {
  initCompiler({ projectRoot: resolve(import.meta.dir, '../../../..'), isBundledExe: false });
});

let sandbox: string | null = null;

afterEach(async () => {
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
  sandbox = null;
});

async function makeSandbox(files: Record<string, string>): Promise<string> {
  sandbox = await mkdtemp(join(tmpdir(), 'yaar-worker-'));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(sandbox, path, '..'), { recursive: true });
    await Bun.write(join(sandbox, path), text);
  }
  return sandbox;
}

const MATH = `export const square = (n: number) => n * n;\n`;
const WORKER = `import { square } from './math';
self.onmessage = (e: MessageEvent<number>) => self.postMessage(square(e.data));
`;

describe('?worker imports', () => {
  test('bundle a worker with its own imports, and run it', async () => {
    const dir = await makeSandbox({
      'src/math.ts': MATH,
      'src/square.worker.ts': WORKER,
      'src/entry.ts': `import SquareWorker from './square.worker.ts?worker';
export function squareInWorker(n: number): Promise<number> {
  const w = new SquareWorker();
  return new Promise((done) => {
    w.onmessage = (e) => { w.terminate(); done(e.data); };
    w.postMessage(n);
  });
}
`,
    });
    const built = await buildAppBundle(join(dir, 'src/entry.ts'), { minify: true });
    expect(built.logs.filter((l) => l.level === 'error')).toEqual([]);
    expect(built.success).toBe(true);
    // One artifact: the worker is inside the entry, never a sibling chunk.
    expect(built.outputs.map((o) => o.kind)).toEqual(['entry-point']);

    const modulePath = join(dir, 'out.mjs');
    await Bun.write(modulePath, await built.outputs[0]!.text());
    const { squareInWorker } = await import(modulePath);
    expect(await squareInWorker(7)).toBe(49);
  });

  test('the factory works without `new`, and extensionless specifiers resolve', async () => {
    const dir = await makeSandbox({
      'src/math.ts': MATH,
      'src/square.worker.ts': WORKER,
      'src/entry.ts': `import makeWorker from './square.worker?worker';
export const run = (n: number) => new Promise<number>((done) => {
  const w = makeWorker();
  w.onmessage = (e) => { w.terminate(); done(e.data); };
  w.postMessage(n);
});
`,
    });
    const built = await buildAppBundle(join(dir, 'src/entry.ts'), { minify: false });
    expect(built.success).toBe(true);
    const modulePath = join(dir, 'out.mjs');
    await Bun.write(modulePath, await built.outputs[0]!.text());
    const { run } = await import(modulePath);
    expect(await run(5)).toBe(25);
  });

  test('a compiled app carries the worker inside its one HTML file', async () => {
    const dir = await makeSandbox({
      'src/math.ts': MATH,
      'src/square.worker.ts': WORKER,
      'src/main.ts': `import SquareWorker from './square.worker.ts?worker';
export const worker = SquareWorker;
`,
    });
    const result = await compileTypeScript(dir, { minify: false });
    expect(result.errors ?? []).toEqual([]);
    expect(result.success).toBe(true);
    const html = await Bun.file(result.outputPath!).text();
    expect(html).toContain('URL.createObjectURL');
    expect(html).toMatch(/type:\s*["']module["']/);
  });

  test('the YAAR SDK is refused inside a worker, by name', async () => {
    const dir = await makeSandbox({
      'src/bad.worker.ts': `import { appStorage } from '@bundled/yaar';\nexport const s = appStorage;\n`,
      'src/main.ts': `import Bad from './bad.worker.ts?worker';\nexport const b = Bad;\n`,
    });
    const result = await compileTypeScript(dir, { minify: false });
    expect(result.success).toBe(false);
    expect(result.errors!.join('\n')).toContain('cannot be imported inside a ?worker module');
  });

  test('a worker build failure names the worker file', async () => {
    const dir = await makeSandbox({
      'src/broken.worker.ts': `import { nope } from './missing';\nself.postMessage(nope);\n`,
      'src/main.ts': `import Broken from './broken.worker.ts?worker';\nexport const b = Broken;\n`,
    });
    const result = await compileTypeScript(dir, { minify: false });
    expect(result.success).toBe(false);
    expect(result.errors!.join('\n')).toContain('broken.worker.ts');
  });

  test('a package specifier is refused — a worker is a file in the app', async () => {
    const dir = await makeSandbox({
      'src/main.ts': `import W from 'some-pkg?worker';\nexport const w = W;\n`,
    });
    const result = await compileTypeScript(dir, { minify: false });
    expect(result.success).toBe(false);
    expect(result.errors!.join('\n')).toContain('must be a relative path');
  });
});

test('workers that start each other are refused as a cycle, not recursed into', async () => {
  const dir = await makeSandbox({
    'src/ping.worker.ts': `import Pong from './pong.worker.ts?worker';\nexport const p = Pong;\n`,
    'src/pong.worker.ts': `import Ping from './ping.worker.ts?worker';\nexport const p = Ping;\n`,
    'src/main.ts': `import Ping from './ping.worker.ts?worker';\nexport const p = Ping;\n`,
  });
  const result = await compileTypeScript(dir, { minify: false });
  expect(result.success).toBe(false);
  expect(result.errors!.join('\n')).toContain('Worker import cycle');
});
