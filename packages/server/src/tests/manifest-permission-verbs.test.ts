/**
 * A malformed `verbs` on an app.json permission entry fails closed.
 *
 * An object entry with no `verbs` confers every verb, and the parser used to keep `verbs`
 * only when it was an array of strings — dropping anything else *silently*. So an author
 * narrowing a grant who got the shape wrong got the widest grant instead:
 * `"verbs": "read"` or `["read", null]` became read, list, invoke **and delete**. Bundled
 * apps get their permissions with no install dialog, so nothing ever showed it.
 *
 * The entry is now dropped, the reason is recorded on the manifest, and every reader that
 * can reach the author says so with the app id: `getAppMeta` logs it, deploy refuses, and
 * `check:apps` fails (the last is pinned by running it, not here).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { invalidateManifest, normalizeManifest } from '../features/apps/manifest.js';
import { getAppMeta } from '../features/apps/discovery.js';
import { doDeploy, type DeployRefusal } from '../features/dev/deploy.js';
import { USER_APPS_DIR } from '../features/apps/roots.js';
import { isUriAllowed } from '../http/uri-match.js';

const PHOTOS = 'yaar://storage/shared/photos/';

describe('parsing a permission entry’s verbs', () => {
  for (const [label, verbs] of [
    ['a string', 'read'],
    ['an array holding null', ['read', null]],
    ['an array holding a number', ['read', 1]],
    ['null', null],
    ['an object', { read: true }],
  ] as const) {
    it(`drops the entry when verbs is ${label}, and says why`, () => {
      const m = normalizeManifest({ permissions: [{ uri: PHOTOS, verbs }, 'yaar://http'] })!;

      expect(m.permissions).toEqual(['yaar://http']);
      expect(m.problems).toHaveLength(1);
      expect(m.problems[0]).toContain('permissions[0]');
      expect(m.problems[0]).toContain(PHOTOS);
      // The widening this closes: that entry must confer nothing, delete least of all.
      for (const verb of ['read', 'delete'] as const) {
        expect(isUriAllowed(`${PHOTOS}a.jpg`, verb, m.permissions!)).toBe(false);
      }
    });
  }

  it('keeps the known verbs of a list and reports the unknown ones', () => {
    const m = normalizeManifest({ permissions: [{ uri: PHOTOS, verbs: ['raed', 'read'] }] })!;

    expect(m.permissions).toEqual([{ uri: PHOTOS, verbs: ['read'] }]);
    expect(m.problems).toHaveLength(1);
    expect(m.problems[0]).toContain('"raed"');
    expect(isUriAllowed(`${PHOTOS}a.jpg`, 'read', m.permissions!)).toBe(true);
    expect(isUriAllowed(`${PHOTOS}a.jpg`, 'delete', m.permissions!)).toBe(false);
  });

  it('reports nothing for a well-formed list, and still reads a missing verbs as every verb', () => {
    const m = normalizeManifest({
      permissions: [{ uri: PHOTOS, verbs: ['read', 'list'] }, { uri: 'yaar://http' }, 'x'],
    })!;

    expect(m.problems).toEqual([]);
    expect(m.permissions).toEqual([
      { uri: PHOTOS, verbs: ['read', 'list'] },
      { uri: 'yaar://http' },
      'x',
    ]);
  });
});

describe('an installed app whose manifest has a malformed verbs', () => {
  const APP_ID = 'zz-malformed-verbs';
  const appDir = join(USER_APPS_DIR, APP_ID);

  beforeEach(async () => {
    await mkdir(appDir, { recursive: true });
    await writeFile(
      join(appDir, 'app.json'),
      JSON.stringify({ permissions: [{ uri: PHOTOS, verbs: 'read' }] }),
    );
    invalidateManifest(appDir);
  });

  afterAll(async () => {
    await rm(appDir, { recursive: true, force: true });
  });

  it('holds none of that grant, and the log names the app', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const meta = await getAppMeta(APP_ID);
      expect(meta?.permissions ?? []).toEqual([]);

      const said = warn.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
      expect(said).toContain(APP_ID);
      expect(said).toContain('"verbs" must be an array');

      // Once per app per problem — this runs on every window create and door check.
      warn.mockClear();
      await getAppMeta(APP_ID);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('deploying a project whose app.json has a malformed verbs', () => {
  const APP_ID = 'zz-malformed-verbs-deploy';
  const installedDir = join(USER_APPS_DIR, APP_ID);
  const INSTALLED = JSON.stringify({ appId: APP_ID, name: 'Installed' });
  let sandbox: string;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'yaar-malformed-verbs-'));
    await mkdir(join(sandbox, 'dist'), { recursive: true });
    await writeFile(join(sandbox, 'dist', 'index.html'), '<!doctype html><p>hi</p>');
    await writeFile(join(sandbox, 'dist', 'protocol.json'), JSON.stringify({ commands: {} }));
    // Installed first, so the deploy targets this temp root: a first deploy lands in the
    // real apps/ tree, and a regression here would leave an app behind in the checkout.
    await mkdir(installedDir, { recursive: true });
    await writeFile(join(installedDir, 'app.json'), INSTALLED);
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
    await rm(installedDir, { recursive: true, force: true });
  });

  it('is refused, naming the entry, before anything is written', async () => {
    await writeFile(
      join(sandbox, 'app.json'),
      JSON.stringify({ permissions: [{ uri: PHOTOS, verbs: ['read', null] }] }),
    );

    const result = await doDeploy(APP_ID, { appId: APP_ID, sourcePath: sandbox });

    expect(result.success).toBe(false);
    const { error } = result as DeployRefusal;
    expect(error).toContain(APP_ID);
    expect(error).toContain('permissions[0]');
    expect(await Bun.file(join(installedDir, 'app.json')).text()).toBe(INSTALLED);
    expect(await Bun.file(join(installedDir, 'dist', 'index.html')).exists()).toBe(false);
  });
});
