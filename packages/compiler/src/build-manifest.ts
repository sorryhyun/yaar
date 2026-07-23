/**
 * Build manifest for tracking app compilation state.
 *
 * Each compiled app gets a `.build-manifest.json` in its dist/ directory
 * containing hashes of source files and app.json. This allows the server
 * to detect stale builds and auto-recompile on startup.
 */

import { readdir, stat } from 'fs/promises';
import { join, basename } from 'path';

/**
 * Bump this to force a full rebuild of all apps.
 *
 * Staleness is otherwise judged from an app's own src/ and app.json, so a change to
 * something the compiler *injects* — the design tokens, or an SDK script out of
 * @yaar/shared/iframe-scripts — leaves every hash identical and reaches no existing
 * dist/. Bumping is how such a change gets picked up. ('5': the yaar-ml shim loads
 * onnxruntime from /api/ml-runtime/ and runs it on a worker, so any app that bundled
 * the old main-thread copy has to be rebuilt. '6': that worker is also why the shim
 * now has to put the REMOTE token on the externalData URLs ORT fetches itself —
 * without a rebuild, every installed build still ships the copy that 401s. '7': the
 * design tokens gained the y-modal-title/msg/actions classes the new showAlert/
 * showConfirm/showPrompt dialogs render with — an old build calling them would get
 * unstyled markup.) '8': the dark palette moved to GitHub Dark Dimmed and
 * .y-btn-primary now fills with the new --yaar-accent-emphasis token — an old
 * build keeps the near-black canvas and paints its primary button with a token
 * its baked-in CSS never defines. '10': the capture SDK now composites live
 * canvas pixels into a full-window screenshot and honors app.register's new
 * onCapture provider — the app-protocol script that wires onCapture is not
 * hot-upgraded, so old builds must be recompiled to pick it up. '11': @bundled/
 * dompurify entered the catalog and eight apps moved their untrusted-HTML sinks
 * onto it. Those apps' own hashes changed, so they would rebuild regardless —
 * the bump is here to guarantee no installed dist/ predating the sanitization
 * work survives on a machine whose hashes happen to match, since a stale copy of
 * one of these apps is an unsanitized innerHTML sink rather than a cosmetic lag.
 * '13': the yaar-ml shim now pins ORT's log level to 'error', silencing the
 * EP-partition warning every WebGPU session emits. The level is baked into the
 * bundled shim, so an app that does not rebuild keeps printing it.)
 */
export const COMPILER_VERSION = '13';

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

  const [sourceHash, appJsonHash] = await Promise.all([
    computeSourceHash(appPath),
    computeAppJsonHash(appPath),
  ]);

  if (!sourceHash) return true; // no src/ directory
  return manifest.sourceHash !== sourceHash || manifest.appJsonHash !== appJsonHash;
}
