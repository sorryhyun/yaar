/**
 * Build manifest for tracking app compilation state.
 *
 * Each compiled app gets a `.build-manifest.json` in its dist/ directory
 * containing hashes of source files and app.json. This allows the server
 * to detect stale builds and auto-recompile on startup.
 */

import { readdir, stat } from 'fs/promises';
import { join, basename } from 'path';
import { getOrtVersion } from '../bundled/ort-version.js';

/**
 * Bump this to force a full rebuild of all apps.
 *
 * Staleness is otherwise judged from an app's own src/ and app.json, so a change to
 * something the compiler *injects or emits* — the design tokens stylesheet, an SDK script
 * out of @yaar/shared/iframe-scripts, the bundled `@bundled/yaar` shim, the protocol
 * extraction — leaves every hash identical and reaches no existing dist/. The apps that
 * need such a fix are exactly the installed ones nobody is about to edit, so without a
 * bump it would only reach whichever apps happened to go stale.
 *
 * "The server injects a newer copy at serve time" is usually not enough, for two reasons:
 * - `installGuard` lets the first copy win, and the one baked into dist/ runs first, so it
 *   shadows the injected upgrade even for a same-origin app.
 * - An origin-isolated app gets nothing injected at all; its dist/ copy is the only one.
 *
 * Not needed for an onnxruntime-web upgrade: the manifest records `ortVersion` and
 * `isAppStale` compares it.
 *
 * The reason for every bump up to '41' used to be recorded here; that changelog is at
 * `git show f85e4670:packages/compiler/src/build/build-manifest.ts`. Put the reason for a
 * new bump in its commit message instead.
 */
export const COMPILER_VERSION = '41';

export interface BuildManifest {
  sourceHash: string;
  appJsonHash: string;
  compilerVersion: string;
  /** The onnxruntime-web version stamped into a `yaar-ml` app's shim; absent for other apps. */
  ortVersion?: string;
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
        // Ignore macOS cruft (`.DS_Store`, `._*` AppleDouble sidecars) so it never
        // perturbs the source hash (spurious drift detection on publish, spurious recompiles).
        const name = basename(rel);
        if (name === '.DS_Store' || name.startsWith('._')) return null;
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
  // A yaar-ml app's runtime URLs carry the ORT version it was built against.
  const ortVersion = getOrtVersion();
  if (manifest.ortVersion && ortVersion && manifest.ortVersion !== ortVersion) return true;

  const [sourceHash, appJsonHash] = await Promise.all([
    computeSourceHash(appPath),
    computeAppJsonHash(appPath),
  ]);

  if (!sourceHash) return true; // no src/ directory
  return manifest.sourceHash !== sourceHash || manifest.appJsonHash !== appJsonHash;
}
