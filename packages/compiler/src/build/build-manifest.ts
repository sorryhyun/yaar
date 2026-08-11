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
 * bundled shim, so an app that does not rebuild keeps printing it. '14': the
 * HTML wrapper now carries the extracted manifest as `window.__yaar_manifest__`,
 * and `defineApp` reads its `params`/`returns`/`schema` from it. An app built
 * before this has no such script, so a Zod schema would reach agents as an
 * opaque object; the injected copy is also what keeps the manifest the iframe
 * serves identical to `dist/protocol.json` rather than merely agreeing with it.
 * '15': `app.register()` was removed — registration moved to `defineApp`'s
 * private `__registerApp` entry, and the public name now throws. Both halves of
 * that pair are baked into a dist (the injected app-protocol script and the
 * bundled `defineApp` shim), so an old build is self-consistent and would keep
 * running its removed registration path indefinitely. Forcing the rebuild is
 * what makes an unmigrated app fail loudly, with the extractor naming the fix,
 * instead of quietly outliving the removal.) '16': the prune pass — `showAlert`
 * left `@bundled/yaar`, and `clsx`/`konva`/`p5` left the bundled-library
 * registry, all four at zero consumers. Nothing installed imports them, so the
 * bump buys no migration; it exists so no dist/ survives carrying a bundled copy
 * of surface the repo no longer resolves, which is the state that makes a later
 * "why does this still build?" report unanswerable. '17': the `--yaar-wash-*`
 * tokens plus the `y-wash-*`/`y-dot*`/`y-progress*` utilities entered the
 * injected stylesheet, and the chrome's own baked `rgba()` tints moved onto
 * them. The tokens CSS is inlined into every dist/index.html, so an app that
 * does not rebuild keeps the pre-wash sheet: the new classes would resolve to
 * nothing and the chrome would stay dark-tinted under `.y-light`. '18': the
 * micro-helper additions to `@bundled/yaar` (`safeParseOr`, `tryToast`,
 * `escapeHtml`, `downloadBlob`/`blobToDataUrl`, the `format*` trio). Additive,
 * so no unrebuilt app is broken by it — and the SDK is bundled *into* each app,
 * so a bundle's helper set is otherwise a function of when that app last
 * happened to be stale. The bump makes every dist/ carry one SDK vintage, which
 * is what keeps "does this build have `formatBytes`?" answerable from the
 * manifest instead of from the app's edit history. '20': repeated subschemas fold
 * into one protocol-level `$defs` (`protocol/dedupe-schemas.ts`, plus zod's own
 * `reused: 'ref'` in the fold). This is the case the bump exists for in its purest
 * form — the pass changes what the *compiler emits*, not what the app's source
 * says, so every hash stays identical and no existing `dist/protocol.json` would
 * ever be reached. Without it the shrink applies only to apps that happen to be
 * edited afterwards, which is the opposite of the point: the app it was written
 * for (studio-3d, whose manual crossed the CLI's inline-delivery cliff) is a
 * user-installed app nobody is about to edit.
 *
 * '21': the injected storage SDK resolves every spelling of a storage reference
 * (`storage-sdk.ts`), and `@bundled/yaar` exports `storagePath`. Same reason as '18'
 * and '20' together — the SDK script is injected into each `dist/`, so which dialects
 * an app understands would otherwise be a function of when it last happened to be
 * stale, and the four apps this fixes (a namespaced URI silently mishandled, a
 * token-less `/api/storage` URL) are exactly the ones nobody is about to edit.
 */
export const COMPILER_VERSION = '21';

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
