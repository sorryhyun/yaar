/**
 * Two-phase publish freeze + source-drift detection (`features/apps/publish-staging.ts`).
 *
 * The drift core is exercised two ways: directly, as path-based hashing over a
 * throwaway app tree (`captureBaseline`/`baselineDrifted`), and end-to-end through
 * `prepare`/`finalize` against the real bundled `memo` app. `memo` is only ever
 * read — drift is simulated by overwriting the frozen baseline via a test hook, so
 * no tracked app is mutated and no network is touched (the uploader is injected).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  captureBaseline,
  baselineDrifted,
  preparePublication,
  finalizePublication,
  cancelPublication,
  getPendingPublication,
  __setBaselineForTest,
} from '../features/apps/publish-staging.js';
import { isNewerVersion, parseSemver, versionPublishError } from '../features/apps/version.js';
import type { PublishResult } from '../features/apps/publish.js';

/** Prepare with the version guard stubbed to "unpublished" so it never hits the network. */
function prepare(appId: string) {
  return preparePublication(appId, { publishedVersionOf: async () => null });
}

let storageRoot: string;

beforeAll(async () => {
  // Freeze bytes and shadow repos into a throwaway dir, not the real storage/.
  storageRoot = await mkdtemp(join(tmpdir(), 'yaar-pubstage-'));
  process.env.YAAR_STORAGE = storageRoot;
});

afterAll(async () => {
  delete process.env.YAAR_STORAGE;
  await rm(storageRoot, { recursive: true, force: true });
});

/** A minimal on-disk app: `src/main.ts` + `app.json`, the inputs the hashers read. */
async function makeApp(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'yaar-app-'));
  await mkdir(join(dir, 'src'), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, content);
  }
  return dir;
}

/** Records the bytes it was handed so we can assert the *frozen* tarball shipped. */
function fakeUploader() {
  const calls: { appId: string; byteLength: number }[] = [];
  const upload = async (appId: string, tarball: Buffer): Promise<PublishResult> => {
    calls.push({ appId, byteLength: tarball.byteLength });
    return { success: true, message: 'ok', commit: 'deadbeef', files: 1 };
  };
  return { upload, calls };
}

describe('drift core (path-based)', () => {
  it('reports no drift for an unchanged tree', async () => {
    const dir = await makeApp({
      'src/main.ts': 'export const x = 1;\n',
      'app.json': '{"id":"t","version":"1.0.0"}\n',
    });
    const base = await captureBaseline(dir);
    expect(base.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await baselineDrifted(dir, base)).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  it('detects a source change and an app.json change independently', async () => {
    const dir = await makeApp({
      'src/main.ts': 'export const x = 1;\n',
      'app.json': '{"id":"t","version":"1.0.0"}\n',
    });
    const base = await captureBaseline(dir);

    await writeFile(join(dir, 'src', 'main.ts'), 'export const x = 2;\n');
    expect(await baselineDrifted(dir, base)).toBe(true);

    // Restore source; now move only the manifest.
    await writeFile(join(dir, 'src', 'main.ts'), 'export const x = 1;\n');
    expect(await baselineDrifted(dir, base)).toBe(false);
    await writeFile(join(dir, 'app.json'), '{"id":"t","version":"1.0.1"}\n');
    expect(await baselineDrifted(dir, base)).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });

  it('detects a newly added source file', async () => {
    const dir = await makeApp({
      'src/main.ts': 'export const x = 1;\n',
      'app.json': '{"id":"t"}\n',
    });
    const base = await captureBaseline(dir);
    await writeFile(join(dir, 'src', 'extra.ts'), 'export const y = 2;\n');
    expect(await baselineDrifted(dir, base)).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('prepare / freeze / cancel (real bundled app: memo)', () => {
  beforeEach(async () => {
    // Clear any freeze left by a prior test so one-live-per-app is deterministic.
    const stagingDir = join(storageRoot, 'publish-staging');
    if (existsSync(stagingDir)) {
      for (const f of await readdir(stagingDir)) {
        await rm(join(stagingDir, f), { force: true });
      }
    }
  });

  it('freezes bytes and reports a digest summary', async () => {
    const prep = await prepare('memo');
    expect(prep.success).toBe(true);
    if (!prep.success) return;

    const { summary } = prep;
    expect(summary.appId).toBe('memo');
    expect(summary.version).toBe('1.0.0');
    expect(summary.artifactSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(summary.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(summary.byteLength).toBeGreaterThan(0);

    // The frozen tarball is on disk and the record is retrievable.
    const staged = await readdir(join(storageRoot, 'publish-staging'));
    expect(staged.some((f) => f.startsWith(summary.publicationId))).toBe(true);
    expect(getPendingPublication(summary.publicationId)?.artifactSha256).toBe(
      summary.artifactSha256,
    );

    // Cancel removes both the record and the frozen bytes.
    expect(await cancelPublication(summary.publicationId)).toBe(true);
    expect(getPendingPublication(summary.publicationId)).toBeNull();
    const after = await readdir(join(storageRoot, 'publish-staging'));
    expect(after.some((f) => f.startsWith(summary.publicationId))).toBe(false);
  });

  it('supersedes an earlier freeze — one live prepare per app', async () => {
    const first = await prepare('memo');
    const second = await prepare('memo');
    expect(first.success && second.success).toBe(true);
    if (!first.success || !second.success) return;

    expect(getPendingPublication(first.summary.publicationId)).toBeNull();
    expect(getPendingPublication(second.summary.publicationId)).not.toBeNull();
    await cancelPublication(second.summary.publicationId);
  });
});

describe('finalize / drift gate', () => {
  it('uploads the frozen bytes when the source has not drifted', async () => {
    const prep = await prepare('memo');
    expect(prep.success).toBe(true);
    if (!prep.success) return;
    const { upload, calls } = fakeUploader();

    const outcome = await finalizePublication(prep.summary.publicationId, {
      expectedAppId: 'memo',
      upload,
    });

    expect(outcome.status).toBe('published');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ appId: 'memo', byteLength: prep.summary.byteLength });
    // A published freeze is consumed.
    expect(getPendingPublication(prep.summary.publicationId)).toBeNull();
  });

  it('refuses to upload on drift, then ships the frozen snapshot when acknowledged', async () => {
    const prep = await prepare('memo');
    expect(prep.success).toBe(true);
    if (!prep.success) return;
    const id = prep.summary.publicationId;

    // Simulate the source moving under us: the live hash no longer matches the freeze.
    __setBaselineForTest(id, { sourceHash: 'stale', appJsonHash: 'stale' });

    const refused = await finalizePublication(id, {
      expectedAppId: 'memo',
      upload: fakeUploader().upload,
    });
    expect(refused.status).toBe('drift_detected');
    expect(refused.drift?.drifted).toBe(true);
    // The freeze survives a refusal so it can be acknowledged or re-prepared.
    expect(getPendingPublication(id)).not.toBeNull();

    const acked = fakeUploader();
    const outcome = await finalizePublication(id, {
      expectedAppId: 'memo',
      acknowledgeDrift: true,
      upload: acked.upload,
    });
    expect(outcome.status).toBe('published');
    expect(acked.calls).toHaveLength(1);
  });

  it('rejects a publicationId that belongs to a different app', async () => {
    const prep = await prepare('memo');
    expect(prep.success).toBe(true);
    if (!prep.success) return;

    const outcome = await finalizePublication(prep.summary.publicationId, {
      expectedAppId: 'storage',
      upload: fakeUploader().upload,
    });
    expect(outcome.status).toBe('error');
    await cancelPublication(prep.summary.publicationId);
  });

  it('reports not_found for an unknown publication', async () => {
    const outcome = await finalizePublication('pubver_nope', { upload: fakeUploader().upload });
    expect(outcome.status).toBe('not_found');
  });
});

describe('version guard', () => {
  it('orders semver correctly, including multi-digit segments', () => {
    expect(parseSemver('1.2.3')).toEqual([1, 2, 3]);
    expect(parseSemver('1.0.0-beta.1')).toEqual([1, 0, 0]); // prerelease stripped
    expect(parseSemver('not-a-version')).toBeNull();

    expect(isNewerVersion('1.0.1', '1.0.0')).toBe(true);
    expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false); // equal is not newer
    expect(isNewerVersion('0.9.9', '1.0.0')).toBe(false);
    expect(isNewerVersion('1.10.0', '1.2.0')).toBe(true); // 10 > 2, not string order
    expect(isNewerVersion('2.0', '1.9.9')).toBe(true);
    expect(isNewerVersion('weird', '1.0.0')).toBe(true); // unparseable → never block
  });

  it('blocks a not-newer version and allows a bumped or unpublished one', async () => {
    const published = async () => '1.4.0';
    expect(await versionPublishError('x', '1.4.0', published)).toMatch(/not newer/);
    expect(await versionPublishError('x', '1.3.0', published)).toMatch(/not newer/);
    expect(await versionPublishError('x', '1.4.1', published)).toBeNull();

    // Unpublished app or unreachable catalog → allow (marketplace is the backstop).
    expect(await versionPublishError('x', '1.0.0', async () => null)).toBeNull();
    expect(
      await versionPublishError('x', '1.0.0', async () => {
        throw new Error('offline');
      }),
    ).toBeNull();
  });

  it('refuses prepare — no freeze — when the version is already published', async () => {
    const before = existsSync(join(storageRoot, 'publish-staging'))
      ? (await readdir(join(storageRoot, 'publish-staging'))).length
      : 0;

    const prep = await preparePublication('memo', {
      publishedVersionOf: async () => '9.9.9', // memo is 1.0.0 → not newer
    });
    expect(prep.success).toBe(false);
    if (prep.success) return;
    expect(prep.error).toMatch(/not newer/);

    // A blocked prepare must not have staged any bytes.
    const after = existsSync(join(storageRoot, 'publish-staging'))
      ? (await readdir(join(storageRoot, 'publish-staging'))).length
      : 0;
    expect(after).toBe(before);
  });
});
