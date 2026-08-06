/**
 * A devtools preview may use the gated SDKs its project declared.
 *
 * `bundles` is manifest-only by design — a caller that could pass it would mint
 * itself `yaar-dev`. But a preview runs under `preview--{projectId}`, which
 * `getAppMeta` cannot resolve, so the manifest lookup returned nothing and every
 * gated door (`/api/browser`, `/api/dev/*`, `/api/ml-*`) 403'd the preview. An app
 * declaring `yaar-web` could only be tested after it shipped. The fix reads
 * `bundles` off the project's own app.json on disk — still the project's declared
 * identity, still not the request's claim.
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { previewBundles } from '../http/iframe-tokens.js';
import { requireBundle, type AppPrincipal } from '../http/access.js';

// The storage root is passed explicitly rather than via YAAR_STORAGE: env is
// process-global and the unit suite shares one process across files.
const STORAGE = mkdtempSync(join(tmpdir(), 'yaar-preview-bundles-'));

function writeProject(id: string, manifest: unknown) {
  const dir = join(STORAGE, 'apps', 'devtools', 'projects', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'app.json'), JSON.stringify(manifest));
}

beforeAll(() => {
  writeProject('dc', { name: 'DC', bundles: ['yaar-web'] });
  writeProject('plain', { name: 'Plain' });
  writeProject('junk', { bundles: ['yaar-web', 7, { uri: 'x' }] });
  writeProject('dock', { bundles: ['yaar-dev'] });
});

describe('preview iframe bundles', () => {
  it('carries the gated SDKs the previewed project declared', async () => {
    expect(await previewBundles('preview--dc', STORAGE)).toEqual(['yaar-web']);
  });

  it('grants nothing when the project declares no bundles', async () => {
    expect(await previewBundles('preview--plain', STORAGE)).toBeUndefined();
  });

  it('grants nothing for a project that does not exist', async () => {
    expect(await previewBundles('preview--missing', STORAGE)).toBeUndefined();
  });

  it('refuses a project id that would climb out of the projects directory', async () => {
    expect(await previewBundles('preview--../../../etc', STORAGE)).toBeUndefined();
  });

  it('drops non-string entries rather than trusting the file’s shape', async () => {
    expect(await previewBundles('preview--junk', STORAGE)).toEqual(['yaar-web']);
  });

  it('leaves a non-preview app to its real manifest', async () => {
    // A stray projects/dock/app.json must not reach the installed `dock` app.
    expect(await previewBundles('dock', STORAGE)).toBeUndefined();
    expect(await previewBundles(undefined, STORAGE)).toBeUndefined();
  });
});

/**
 * The mint above is silent on its ordinary paths (see `previewBundles`), so the
 * refusal is where a developer learns which app.json was consulted. The generic
 * wording names "app.json" — for a preview that is the *project's* file, not an
 * installed app's, and pointing at the wrong one is what made the original 403
 * point nowhere near the cause.
 */
describe('gated-SDK refusal for a preview', () => {
  const principal = (appId: string): AppPrincipal => ({
    kind: 'app',
    appId,
    sessionId: 's1',
    windowId: 'w1',
    permissions: [],
    systemApp: false,
    bundles: [],
    streams: [],
    token: 't',
  });

  it('sends a preview to its project file', async () => {
    const denied = requireBundle(principal('preview--dc'), 'yaar-web');
    expect(denied?.status).toBe(403);
    expect(await denied!.text()).toContain("preview project's own app.json");
  });

  it('leaves an installed app the generic wording', async () => {
    const denied = requireBundle(principal('notes'), 'yaar-web');
    expect(denied?.status).toBe(403);
    expect(await denied!.text()).toContain('must be declared in app.json');
  });

  it('still admits a preview that declared the bundle', () => {
    expect(requireBundle({ ...principal('preview--dc'), bundles: ['yaar-web'] }, 'yaar-web')).toBe(
      null,
    );
  });
});
