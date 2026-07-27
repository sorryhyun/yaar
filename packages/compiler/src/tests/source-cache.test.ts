/**
 * One read per file per compile — and never across two.
 *
 * The cache exists to collapse three full reads of an app's `src/` into one. The
 * failure it could introduce is worse than the cost it removes: a cache that
 * outlived a compile would hand the bundler the previous edit's source, so
 * `dev.ts`'s recompile-on-save would report success over stale bytes. Both
 * halves are asserted here.
 */
import { afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { initCompiler } from '../config.js';
import { compileTypeScript } from '../compile.js';
import { AppSourceCache } from '../build/source-cache.js';

// Each compile case pays for a real Bun.build().
setDefaultTimeout(30_000);

beforeAll(() => {
  initCompiler({ projectRoot: resolve(import.meta.dir, '../../../..'), isBundledExe: false });
});

let sandbox: string | null = null;

afterEach(async () => {
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
  sandbox = null;
});

async function makeApp(files: Record<string, string>): Promise<string> {
  sandbox = await mkdtemp(join(tmpdir(), 'yaar-source-cache-'));
  await mkdir(join(sandbox, 'src'), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    await Bun.write(join(sandbox, rel), content);
  }
  return sandbox;
}

describe('AppSourceCache', () => {
  test('reads a file once, and collects by app-relative path', async () => {
    const app = await makeApp({
      'src/main.ts': 'export const main = 1;',
      'src/theme.css': ':root { --yaar-card-bg: red; }',
      'src/nested/util.ts': 'export const util = 2;',
      'src/notes.md': 'not source',
    });
    const cache = new AppSourceCache(join(app, 'src'));

    const ts = cache.collect(/\.tsx?$/);
    expect([...ts.keys()].sort()).toEqual(['src/main.ts', 'src/nested/util.ts']);

    const withCss = cache.collect(/\.(tsx?|css)$/);
    expect([...withCss.keys()].sort()).toEqual([
      'src/main.ts',
      'src/nested/util.ts',
      'src/theme.css',
    ]);
    expect(withCss.get('src/theme.css')).toContain('--yaar-card-bg');

    // The second collect overlaps the first; a file already read is served from
    // memory, which is only observable by deleting it from under the cache.
    await rm(join(app, 'src', 'main.ts'));
    expect(await cache.read(join(app, 'src', 'main.ts'))).toBe('export const main = 1;');
  });

  test('a fresh cache sees the current bytes', async () => {
    const app = await makeApp({ 'src/main.ts': 'export const v = 1;' });
    const first = new AppSourceCache(join(app, 'src'));
    expect(first.collect(/\.ts$/).get('src/main.ts')).toContain('v = 1');

    await Bun.write(join(app, 'src', 'main.ts'), 'export const v = 2;');
    expect(new AppSourceCache(join(app, 'src')).collect(/\.ts$/).get('src/main.ts')).toContain(
      'v = 2',
    );
  });
});

describe('compile does not reuse a previous compile’s sources', () => {
  test('an edited command reaches the second build', async () => {
    // Markers rather than words: the wrapper carries solid's runtime, so a plain
    // "Before"/"After" would match `insertBefore` and pass for the wrong reason.
    const source = (command: string, marker: string) => `import { defineApp } from '@bundled/yaar';
export default defineApp({
  id: 'cache-demo',
  name: 'Cache Demo',
  commands: { ${command}: { description: '${marker}', run: () => '${marker}' } },
});
`;

    const app = await makeApp({ 'src/main.ts': source('first', 'CACHE_MARKER_ONE') });
    const first = await compileTypeScript(app, { title: 'Cache Demo' });
    expect(first.success).toBe(true);
    expect(first.protocol?.commands).toEqual(['first']);

    await Bun.write(join(app, 'src', 'main.ts'), source('second', 'CACHE_MARKER_TWO'));
    const second = await compileTypeScript(app, { title: 'Cache Demo' });
    expect(second.success).toBe(true);
    expect(second.protocol?.commands).toEqual(['second']);

    // The bundle itself, not only the manifest, must carry the new source.
    const html = await Bun.file(join(app, 'dist', 'index.html')).text();
    expect(html).toContain('CACHE_MARKER_TWO');
    expect(html).not.toContain('CACHE_MARKER_ONE');
  });
});
