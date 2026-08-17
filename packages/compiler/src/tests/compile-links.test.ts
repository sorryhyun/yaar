/**
 * What a compiled app tells the SDK about its own links.
 *
 * `window.__yaar_links__` carries app.json's `"links"` into the page, and it is
 * emitted for **every** app, empty or not — because its presence is also how the
 * link guard (iframe-scripts/windows-sdk.ts) tells a compiled app from a plain HTML
 * document shown in a window. The app must not navigate its own frame; the plain
 * document must keep browsing in place. So "no links config" and "not an app" cannot
 * be the same absence.
 *
 * The ordering case is the one that bites silently: the SDK reads the config, so a
 * block emitted after the SDK script would leave every app looking unconfigured with
 * nothing to show for it.
 */
import { beforeAll, afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { initCompiler } from '../config.js';
import { compileTypeScript } from '../compile.js';

// Each case pays for a real Bun.build().
setDefaultTimeout(30_000);

beforeAll(() => {
  initCompiler({
    projectRoot: resolve(import.meta.dir, '../../../..'),
    isBundledExe: false,
  });
});

let sandbox: string | null = null;

afterEach(async () => {
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
  sandbox = null;
});

/** Compile a trivial app with the given app.json, and return its HTML. */
async function compileWithAppJson(appJson: string | null): Promise<string> {
  sandbox = await mkdtemp(join(tmpdir(), 'yaar-links-'));
  await mkdir(join(sandbox, 'src'), { recursive: true });
  await Bun.write(join(sandbox, 'src', 'main.ts'), `export const ready = true;\n`);
  if (appJson !== null) await Bun.write(join(sandbox, 'app.json'), appJson);

  const result = await compileTypeScript(sandbox, { title: 'Links Test', minify: false });
  expect(result.errors ?? []).toEqual([]);
  expect(result.success).toBe(true);
  return Bun.file(result.outputPath!).text();
}

/** The value of `window.__yaar_links__` as the page will see it. */
function linksBlock(html: string): unknown {
  const match = html.match(/window\.__yaar_links__=(\{.*?\});<\/script>/);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]!);
}

describe('window.__yaar_links__', () => {
  test('is emitted even when the app declares nothing — it is also the "is an app" signal', async () => {
    expect(linksBlock(await compileWithAppJson(null))).toEqual({});
    expect(linksBlock(await compileWithAppJson('{"appId":"plain","name":"Plain"}'))).toEqual({});
  });

  test('carries the declared base, so a relative href resolves against the right site', async () => {
    const html = await compileWithAppJson(
      '{"appId":"reader","name":"Reader","links":{"base":"https://m.dcinside.com"}}',
    );
    expect(linksBlock(html)).toEqual({ base: 'https://m.dcinside.com/' });
  });

  test('is emitted before the SDK script that reads it', async () => {
    // The SDK reads the config per call rather than at install, so this is belt and
    // braces — but the document order is the thing a reader will assume is load
    // bearing, and it should be true.
    const html = await compileWithAppJson('{"links":{"base":"https://github.com"}}');
    expect(html.indexOf('window.__yaar_links__')).toBeLessThan(html.indexOf('yaar:open-url'));
  });

  test('ignores a base that is not an absolute http(s) URL rather than failing the build', async () => {
    // A link policy is a convenience. A typo in one must not stop an app that would
    // otherwise ship, and a relative or exotic base is worse than none: it would
    // resolve links to somewhere nobody named.
    for (const base of ['/board', 'javascript:void 0', 'not a url', '']) {
      const html = await compileWithAppJson(`{"links":{"base":${JSON.stringify(base)}}}`);
      expect(linksBlock(html)).toEqual({});
    }
  });

  test('survives an unparseable app.json, which is not this pass to report', async () => {
    expect(linksBlock(await compileWithAppJson('{ not json'))).toEqual({});
  });
});
