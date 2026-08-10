/**
 * A devtools preview holds the permissions its project declared.
 *
 * A preview runs under `preview--{projectId}`, which `getAppMeta` cannot resolve — the
 * project is not installed, that is the point — so the token was minted with an empty
 * permission list and only the automatic `SELF_GRANTS` worked. `appStorage`/`appDb` ran;
 * everything in the project's `permissions` 403'd, so an app whose job was writing to
 * `yaar://storage/media/` could not exercise that path in the environment built for
 * iterating on it. `openPreview` did forward the list, but `window.create` honours a
 * caller-supplied one only for a caller that outranks the app, and devtools is an app.
 *
 * So it is read off the project file, like `bundles` already was — and capped by
 * devtools' own reach, since devtools writes that file and must not be able to mint a
 * principal that outranks it.
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateAppIframeToken,
  previewPermissions,
  validateIframeToken,
} from '../http/iframe-tokens.js';
import { isUriAllowed } from '../http/access.js';
import { getStorageDir } from '../config.js';

// The storage root is passed explicitly rather than via YAAR_STORAGE: env is
// process-global and the unit suite shares one process across files.
const STORAGE = mkdtempSync(join(tmpdir(), 'yaar-preview-perms-'));

function writeProject(id: string, manifest: unknown) {
  const dir = join(STORAGE, 'apps', 'devtools', 'projects', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'app.json'), JSON.stringify(manifest));
}

beforeAll(() => {
  writeProject('media', { name: 'Media', permissions: ['yaar://storage/media/'] });
  writeProject('plain', { name: 'Plain' });
  writeProject('verbs', {
    permissions: [{ uri: 'yaar://storage/reports/', verbs: ['read', 'invoke'] }],
  });
  writeProject('over', { permissions: ['yaar://config/', 'yaar://history/'] });
  writeProject('mixed', { permissions: ['yaar://config/', 'yaar://storage/media/'] });
  writeProject('junk', { permissions: [7, null, { verbs: ['read'] }, 'yaar://storage/media/'] });
  writeProject('devtools', { permissions: ['yaar://storage/'] });
});

describe('preview iframe permissions', () => {
  it('carries the entry the previewed project declared', async () => {
    expect(await previewPermissions('preview--media', STORAGE)).toEqual(['yaar://storage/media/']);
  });

  it('keeps a verb-restricted entry restricted', async () => {
    expect(await previewPermissions('preview--verbs', STORAGE)).toEqual([
      { uri: 'yaar://storage/reports/', verbs: ['read', 'invoke'] },
    ]);
  });

  it('grants nothing when the project declares no permissions', async () => {
    expect(await previewPermissions('preview--plain', STORAGE)).toBeUndefined();
  });

  it('grants nothing for a project that does not exist', async () => {
    expect(await previewPermissions('preview--missing', STORAGE)).toBeUndefined();
  });

  it('refuses a project id that would climb out of the projects directory', async () => {
    expect(await previewPermissions('preview--../../../etc', STORAGE)).toBeUndefined();
  });

  it('drops malformed entries rather than trusting the file’s shape', async () => {
    expect(await previewPermissions('preview--junk', STORAGE)).toEqual(['yaar://storage/media/']);
  });

  it('leaves a non-preview app to its real manifest', async () => {
    // A stray projects/devtools/app.json must not reach the installed `devtools` app.
    expect(await previewPermissions('devtools', STORAGE)).toBeUndefined();
    expect(await previewPermissions(undefined, STORAGE)).toBeUndefined();
  });
});

/**
 * The ceiling. devtools writes the project file, so an unbounded read of it would let
 * devtools mint a principal reaching further than devtools does — `yaar://config/` and
 * `yaar://history/` are the two the devtools prompt names as out of reach.
 */
describe('preview permissions are capped by devtools’ own reach', () => {
  it('drops an entry devtools does not hold', async () => {
    expect(await previewPermissions('preview--over', STORAGE)).toBeUndefined();
  });

  it('keeps the entries that survive and drops only the rest', async () => {
    expect(await previewPermissions('preview--mixed', STORAGE)).toEqual(['yaar://storage/media/']);
  });

  it('never grants a preview more than the granted entries allow', async () => {
    const granted = (await previewPermissions('preview--media', STORAGE)) ?? [];
    expect(isUriAllowed('yaar://storage/media/slides/probe.txt', 'invoke', granted)).toBe(true);
    expect(isUriAllowed('yaar://storage/private/secrets.json', 'read', granted)).toBe(false);
    expect(isUriAllowed('yaar://config/domains', 'read', granted)).toBe(false);
  });
});

/**
 * The wiring, not just the reader. The reader existing is not the fix — the bug was that
 * nothing consulted the project file when the token was minted, and a token is what the
 * gate reads. This also covers the re-mint: every reconnect builds one from identity
 * alone, so a permission that is not derivable here is one a page refresh loses.
 */
describe('the minted token carries them', () => {
  const PROJECT = `mint-${process.pid}`;

  beforeAll(() => {
    const dir = join(getStorageDir(), 'apps', 'devtools', 'projects', PROJECT);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'app.json'),
      JSON.stringify({ permissions: ['yaar://storage/media/', 'yaar://config/'] }),
    );
  });

  it('mints a preview token holding the project’s declared reach, capped', async () => {
    const token = await generateAppIframeToken('win-preview', 'sess-1', {
      appId: `preview--${PROJECT}`,
    });
    const entry = validateIframeToken(token);
    expect(entry?.permissions).toContain('yaar://storage/media/');
    expect(entry?.permissions).not.toContain('yaar://config/');
    // The automatic self-grants are still there — this adds to identity, never replaces it.
    expect(entry?.permissions).toContain('yaar://apps/self/storage/');
  });

  it('leaves an installed app’s manifest as the only source', async () => {
    const entry = validateIframeToken(
      await generateAppIframeToken('win-devtools', 'sess-1', { appId: 'devtools' }),
    );
    expect(entry?.permissions).toContain('yaar://storage/');
  });
});
