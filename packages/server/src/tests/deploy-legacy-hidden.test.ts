/**
 * A redeploy keeps an app's shortcut hidden when its manifest said so the legacy way.
 *
 * `hidden: true` is the old spelling of `createShortcut: false`, and the manifest reader
 * still honours it. Deploy stripped the key as legacy and wrote nothing in its place, so
 * the app that relied on it came back from its next deploy with a desktop shortcut.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { doDeploy, dropLegacyManifestKeys } from '../features/dev/deploy.js';
import { normalizeManifest } from '../features/apps/manifest.js';
import { USER_APPS_DIR } from '../features/apps/roots.js';

describe('dropLegacyManifestKeys', () => {
  it('writes createShortcut: false in place of hidden: true', () => {
    const meta: Record<string, unknown> = { name: 'X', hidden: true };
    dropLegacyManifestKeys(meta);
    expect(meta).toEqual({ name: 'X', createShortcut: false });
  });

  it('leaves the shortcut alone when hidden was false', () => {
    const meta: Record<string, unknown> = { hidden: false };
    dropLegacyManifestKeys(meta);
    expect(meta).toEqual({});
  });

  it('keeps an explicit createShortcut when there is no hidden to translate', () => {
    const meta: Record<string, unknown> = { createShortcut: true, appProtocol: true };
    dropLegacyManifestKeys(meta);
    expect(meta).toEqual({ createShortcut: true });
  });

  // Whatever the combination, the written manifest must read the way the old one did.
  for (const before of [
    { hidden: true },
    { hidden: true, createShortcut: true },
    { hidden: true, createShortcut: false },
    { hidden: false, createShortcut: false },
    { createShortcut: true },
    {},
  ]) {
    it(`preserves the effective shortcut of ${JSON.stringify(before)}`, () => {
      const after: Record<string, unknown> = { ...before };
      dropLegacyManifestKeys(after);
      expect('hidden' in after).toBe(false);
      expect(normalizeManifest(after)!.createShortcut).toBe(
        normalizeManifest(before)!.createShortcut,
      );
    });
  }
});

describe('redeploying an app whose manifest says hidden: true', () => {
  const APP_ID = 'zz-legacy-hidden-test';
  const installedDir = join(USER_APPS_DIR, APP_ID);
  let sandbox: string;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'yaar-legacy-hidden-'));
    await mkdir(join(sandbox, 'dist'), { recursive: true });
    await writeFile(join(sandbox, 'dist', 'index.html'), '<!doctype html><p>hi</p>');
    await writeFile(join(sandbox, 'dist', 'protocol.json'), JSON.stringify({ commands: {} }));

    await mkdir(installedDir, { recursive: true });
    await writeFile(
      join(installedDir, 'app.json'),
      JSON.stringify({ appId: APP_ID, name: 'Hidden', hidden: true }),
    );
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
    await rm(installedDir, { recursive: true, force: true });
  });

  it('writes a manifest that still hides the shortcut', async () => {
    const result = await doDeploy(APP_ID, { appId: APP_ID, sourcePath: sandbox });
    expect(result.success).toBe(true);

    const written = JSON.parse(await Bun.file(join(installedDir, 'app.json')).text());
    expect(written.hidden).toBeUndefined();
    expect(written.createShortcut).toBe(false);
    expect(normalizeManifest(written)!.createShortcut).toBe(false);
  });
});
