/**
 * `features/apps/manifest.ts` — the one reading of app.json, and its cache.
 *
 * The normaliser replaced a dozen hand-rolled reads that disagreed about malformed
 * fields; these pin the rules they now share. The cache is pinned on the three ways a
 * stamp can lie: a hand edit (must be seen), a rewrite inside one clock tick (must be
 * seen), and a same-stamp rewrite by a writer YAAR knows about (seen once invalidated).
 */
import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  invalidateManifest,
  normalizeManifest,
  readManifest,
  readManifestFile,
} from '../features/apps/manifest.js';
import { APPS_DIR, USER_APPS_DIR, listAppDirs } from '../features/apps/roots.js';

const APP_ID = 'manifest-fixture';
const appDir = join(USER_APPS_DIR, APP_ID);
const manifestPath = join(appDir, 'app.json');

/** Write app.json and pin its mtime, so a test decides what the stamp says. */
function writeManifest(json: unknown, mtimeSec = Date.now() / 1000 - 60): void {
  writeFileSync(manifestPath, JSON.stringify(json));
  utimesSync(manifestPath, mtimeSec, mtimeSec);
}

beforeEach(() => {
  rmSync(appDir, { recursive: true, force: true });
  mkdirSync(appDir, { recursive: true });
  invalidateManifest(appDir);
});

afterAll(() => {
  rmSync(appDir, { recursive: true, force: true });
});

describe('normalizeManifest', () => {
  it('is null for anything that is not a JSON object', () => {
    for (const raw of [null, undefined, 'app', 42, [], [{ name: 'x' }]]) {
      expect(normalizeManifest(raw)).toBeNull();
    }
  });

  it('types every key and keeps the file as written', () => {
    const raw = {
      appId: 'demo',
      name: 'Demo',
      icon: '🎮',
      version: '1.2.0',
      variant: 'widget',
      dockEdge: 'top',
      frameless: true,
      defaultWidth: 400,
      messaging: 'all',
      bundles: ['yaar-web'],
      streams: ['agents'],
      subagents: { max: 40 },
      custom: { kept: true },
    };
    const m = normalizeManifest(raw)!;

    expect(m.raw).toBe(raw);
    expect(m.appId).toBe('demo');
    expect(m.name).toBe('Demo');
    expect(m.variant).toBe('widget');
    expect(m.dockEdge).toBe('top');
    expect(m.frameless).toBe(true);
    expect(m.defaultWidth).toBe(400);
    expect(m.messaging).toBe('all');
    expect(m.bundles).toEqual(['yaar-web']);
    expect(m.streams).toEqual(['agents']);
    // Clamped to the per-app ceiling, the number the app will actually get.
    expect(m.subagents).toEqual({ max: 16 });
    expect(m.createShortcut).toBe(true);
    expect(m.kind).toBe('app');
  });

  it('drops a malformed entry from a list rather than the whole list', () => {
    const m = normalizeManifest({
      permissions: [null, 42, 'yaar://storage/shared/', { uri: 'yaar://http' }, { verbs: [] }],
      controls: ['memo', 7, { appId: 'browser', commands: ['go'], minimized: true }],
      bundles: ['yaar-dev', 5],
    })!;

    expect(m.permissions).toEqual(['yaar://storage/shared/', { uri: 'yaar://http' }]);
    expect(m.controls).toEqual([
      { appId: 'memo' },
      { appId: 'browser', commands: ['go'], minimized: true },
    ]);
    expect(m.bundles).toEqual(['yaar-dev']);
  });

  it('reads a wrongly typed scalar as absent', () => {
    const m = normalizeManifest({
      name: 7,
      icon: '',
      description: '',
      variant: 'floating',
      defaultWidth: '400',
      frameless: 'yes',
      kind: 'System',
    })!;

    expect(m.name).toBeUndefined();
    expect(m.icon).toBeUndefined();
    expect(m.description).toBeUndefined();
    expect(m.variant).toBeUndefined();
    expect(m.defaultWidth).toBeUndefined();
    expect(m.frameless).toBe(false);
    expect(m.kind).toBe('app');
  });

  it('treats the legacy hidden flag as createShortcut: false', () => {
    expect(normalizeManifest({ hidden: true })!.createShortcut).toBe(false);
    expect(normalizeManifest({ createShortcut: false })!.createShortcut).toBe(false);
  });

  it('flags the retired personas spelling only when subagents is absent', () => {
    expect(normalizeManifest({ personas: { max: 2 } })!.usesRetiredPersonasKey).toBe(true);
    const both = normalizeManifest({ personas: { max: 2 }, subagents: { max: 2 } })!;
    expect(both.usesRetiredPersonasKey).toBe(false);
  });
});

describe('readManifest', () => {
  it('is null for a missing or unparseable file', async () => {
    expect(await readManifest(appDir)).toBeNull();
    writeFileSync(manifestPath, '{ not json');
    expect(await readManifest(appDir)).toBeNull();
    expect(await readManifestFile(appDir)).toBeNull();
  });

  it('answers repeated reads of an unchanged file from one parse', async () => {
    writeManifest({ name: 'One' });

    const first = await readManifest(appDir);
    expect(first?.name).toBe('One');
    expect(await readManifest(appDir)).toBe(first);
  });

  it('sees a hand edit without being told', async () => {
    writeManifest({ name: 'One' }, Date.now() / 1000 - 60);
    expect((await readManifest(appDir))?.name).toBe('One');

    writeManifest({ name: 'Two' }, Date.now() / 1000 - 30);
    expect((await readManifest(appDir))?.name).toBe('Two');
  });

  it('does not trust a stamp written too recently to have moved', async () => {
    // Same inode, same size, same mtime — two writes inside one tick of the kernel's
    // coarse clock look exactly like this. A file that fresh is re-read, not trusted.
    const now = Date.now() / 1000;
    writeManifest({ name: 'One' }, now);
    expect((await readManifest(appDir))?.name).toBe('One');

    writeManifest({ name: 'Two' }, now);
    expect((await readManifest(appDir))?.name).toBe('Two');
  });

  it('drops a settled entry when invalidated, even if the stamp did not move', async () => {
    const then = Date.now() / 1000 - 60;
    writeManifest({ name: 'One' }, then);
    expect((await readManifest(appDir))?.name).toBe('One');

    // Same size and mtime: the stamp alone cannot see this rewrite.
    writeManifest({ name: 'Two' }, then);
    expect((await readManifest(appDir))?.name).toBe('One');

    invalidateManifest(appDir);
    expect((await readManifest(appDir))?.name).toBe('Two');
  });
});

describe('listAppDirs', () => {
  // One id in both roots: a fixture of its own rather than a real bundled app, since
  // `user-apps/` is shared with the realfs partition running alongside.
  const shadowId = 'manifest-shadow-fixture';
  const shadowDir = join(USER_APPS_DIR, shadowId);
  const bundledShadowDir = join(APPS_DIR, shadowId);
  const linkId = 'manifest-link-fixture';
  const linkPath = join(USER_APPS_DIR, linkId);

  afterAll(() => {
    rmSync(shadowDir, { recursive: true, force: true });
    rmSync(bundledShadowDir, { recursive: true, force: true });
    rmSync(linkPath, { force: true });
  });

  it('lists each id once, bundled first, in id order, following symlinks', async () => {
    mkdirSync(shadowDir, { recursive: true });
    mkdirSync(bundledShadowDir, { recursive: true });
    rmSync(linkPath, { force: true });
    symlinkSync(appDir, linkPath);

    const dirs = await listAppDirs();
    const ids = dirs.map((d) => d.appId);

    expect(ids).toEqual([...ids].sort());
    expect(ids.filter((id) => id === shadowId)).toHaveLength(1);
    expect(dirs.find((d) => d.appId === shadowId)).toEqual({
      appId: shadowId,
      dir: bundledShadowDir,
      source: 'bundled',
    });
    expect(dirs.find((d) => d.appId === linkId)?.source).toBe('user');
  });
});
