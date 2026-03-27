/**
 * Build manifest for tracking app compilation state.
 *
 * Each compiled app gets a `.build-manifest.json` in its dist/ directory
 * containing hashes of source files and app.json. This allows the server
 * to detect stale builds and auto-recompile on startup.
 */

import { readdir, stat } from 'fs/promises';
import { join } from 'path';

/** Bump this to force a full rebuild of all apps. */
export const COMPILER_VERSION = '1';

export interface BuildManifest {
  sourceHash: string;
  appJsonHash: string;
  compilerVersion: string;
  compiledAt: string;
}

const MANIFEST_FILENAME = '.build-manifest.json';

/**
 * Compute a deterministic SHA-256 hash of all files in src/.
 * Files are sorted by path for determinism, and each file's
 * relative path + content is fed into the hash.
 */
export async function computeSourceHash(appPath: string): Promise<string> {
  const srcDir = join(appPath, 'src');
  let files: string[];

  try {
    const entries = await readdir(srcDir, { recursive: true });
    const checks = await Promise.all(
      (entries as string[]).map(async (rel) => {
        try {
          const s = await stat(join(srcDir, rel));
          return s.isFile() ? rel : null;
        } catch {
          return null;
        }
      }),
    );
    files = checks.filter((f): f is string => f !== null);
  } catch {
    return '';
  }

  files.sort();

  const hasher = new Bun.CryptoHasher('sha256');
  for (const rel of files) {
    hasher.update(rel);
    const content = await Bun.file(join(srcDir, rel)).arrayBuffer();
    hasher.update(new Uint8Array(content));
  }
  return hasher.digest('hex');
}

/**
 * Compute SHA-256 of app.json (bundles field affects compilation output).
 */
export async function computeAppJsonHash(appPath: string): Promise<string> {
  try {
    const content = await Bun.file(join(appPath, 'app.json')).arrayBuffer();
    const hasher = new Bun.CryptoHasher('sha256');
    hasher.update(new Uint8Array(content));
    return hasher.digest('hex');
  } catch {
    return '';
  }
}

export async function readBuildManifest(appPath: string): Promise<BuildManifest | null> {
  try {
    const content = await Bun.file(join(appPath, 'dist', MANIFEST_FILENAME)).text();
    return JSON.parse(content) as BuildManifest;
  } catch {
    return null;
  }
}

export async function writeBuildManifest(appPath: string, manifest: BuildManifest): Promise<void> {
  await Bun.write(join(appPath, 'dist', MANIFEST_FILENAME), JSON.stringify(manifest, null, 2));
}

/**
 * Check whether an app needs recompilation.
 * Returns true if stale (needs rebuild), false if fresh.
 */
export async function isAppStale(appPath: string): Promise<boolean> {
  const manifest = await readBuildManifest(appPath);
  if (!manifest) return true;
  if (manifest.compilerVersion !== COMPILER_VERSION) return true;

  const [sourceHash, appJsonHash] = await Promise.all([
    computeSourceHash(appPath),
    computeAppJsonHash(appPath),
  ]);

  if (!sourceHash) return true; // no src/ directory
  return manifest.sourceHash !== sourceHash || manifest.appJsonHash !== appJsonHash;
}
