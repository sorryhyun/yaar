/**
 * An app goes stale when the SDK baked into its dist/ is not the one the compiler would
 * bake now — not only when its own src/ changes. Memo and Anima reached the Android app
 * with a device SDK that predated `host`, and nothing marked them stale.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  COMPILER_VERSION,
  computeAppJsonHash,
  computeSourceHash,
  isAppStale,
  writeBuildManifest,
  type BuildManifest,
} from '../build/build-manifest.js';
import { computeSdkHash } from '../sdk-scripts.js';

let app: string | null = null;

afterEach(async () => {
  if (app) await rm(app, { recursive: true, force: true });
  app = null;
});

async function builtApp(overrides: Partial<BuildManifest>): Promise<string> {
  app = await mkdtemp(join(tmpdir(), 'yaar-manifest-'));
  await mkdir(join(app, 'src'), { recursive: true });
  await mkdir(join(app, 'dist'), { recursive: true });
  await Bun.write(join(app, 'src', 'main.ts'), 'export {};\n');
  await Bun.write(join(app, 'app.json'), '{"name":"t"}\n');
  await writeBuildManifest(app, {
    sourceHash: await computeSourceHash(app),
    appJsonHash: await computeAppJsonHash(app),
    compilerVersion: COMPILER_VERSION,
    sdkHash: computeSdkHash(),
    compiledAt: new Date().toISOString(),
    ...overrides,
  });
  return app;
}

describe('isAppStale and the baked-in SDK', () => {
  test('fresh when the SDK hash matches', async () => {
    expect(await isAppStale(await builtApp({}))).toBe(false);
  });

  test('stale when the SDK hash differs', async () => {
    expect(await isAppStale(await builtApp({ sdkHash: 'an-older-sdk' }))).toBe(true);
  });

  test('stale when the manifest predates the field', async () => {
    expect(await isAppStale(await builtApp({ sdkHash: undefined }))).toBe(true);
  });

  test('the hash is stable within a process', () => {
    expect(computeSdkHash()).toBe(computeSdkHash());
    expect(computeSdkHash()).toMatch(/^[0-9a-f]{64}$/);
  });
});
