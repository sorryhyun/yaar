/**
 * Static asset concerns: MIME table, upload ceiling, the frontend assets the
 * server also has to *read* rather than serve, and the onnxruntime-web runtime
 * artifacts served to app iframes.
 */

import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { CONFIG_MODULE_DIR, IS_BUNDLED_EXE, PROJECT_ROOT } from './env.js';
import { getFrontendDist } from './paths.js';

export const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
  '.md': 'text/markdown',
  '.xml': 'application/xml',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50MB

/**
 * Resolve a frontend asset's *URL* path to a path `Bun.file()` can read.
 *
 * `routes/static.ts` answers the same question for requests it is serving; this
 * exists for the server's own reads of assets it also publishes — the webfonts,
 * which `features/fonts/` parses and subsets on behalf of app iframes that
 * cannot fetch a font into an SVG rasteriser.
 *
 * The two branches are the two shapes a build takes, exactly as
 * `getMlRuntimeArtifact` handles them: a standalone exe has no `dist/` beside it
 * and carries the frontend *inside* the binary, with the `/$bunfs/` paths handed
 * over on `globalThis.__YAAR_EMBEDDED_FRONTEND`.
 *
 * `urlPath` is expected to be rooted (`/NanumSquareNeoOTF-Rg.otf`) and is not
 * traversal-checked — every caller names a constant, never user input.
 *
 * Returns `null` when the asset is not in this build, which callers rely on to
 * mean exactly that: `features/fonts/` filters its catalog through this call, so
 * a path that merely *would* be right if the file existed would advertise a face
 * and then fail on it. Hence the `existsSync` — the embedded branch needs none,
 * since presence in the map is the proof.
 */
export function getFrontendAsset(urlPath: string): string | null {
  const embedded = (globalThis as Record<string, unknown>).__YAAR_EMBEDDED_FRONTEND as
    | Record<string, string>
    | undefined;
  const hit = embedded?.[urlPath];
  if (hit) return hit;

  // `getFrontendDist()` rather than the `FRONTEND_DIST` constant beside it: that
  // one is evaluated at module load, so a test pointing `FRONTEND_DIST` at a
  // fixture directory would be answered from wherever the process happened to
  // start. Same reason `getMlRuntimeArtifact` re-reads its override.
  const path = join(getFrontendDist(), urlPath.replace(/^\//, ''));
  return existsSync(path) ? path : null;
}

/**
 * Directory holding the onnxruntime-web runtime artifacts (`.wasm`/`.mjs`),
 * served to app iframes at `/api/ml-runtime/` for the @bundled/yaar-ml SDK.
 *
 * - Environment override: `YAAR_ML_RUNTIME_DIR`
 * - Bundled exe: `./ml-runtime/` alongside the executable, if the user put one there
 * - Development: resolved from the installed `onnxruntime-web` package's `dist/`
 *
 * A bundled exe normally has no such directory — it carries the artifacts *inside*
 * itself (see `getMlRuntimeArtifact`). Prefer that function; this one is the
 * on-disk half and returns `null` when there is no directory to serve from.
 */
let _mlRuntimeDir: string | null | undefined;
export function getMlRuntimeDir(): string | null {
  if (_mlRuntimeDir !== undefined) return _mlRuntimeDir;

  if (process.env.YAAR_ML_RUNTIME_DIR) {
    _mlRuntimeDir = process.env.YAAR_ML_RUNTIME_DIR;
    return _mlRuntimeDir;
  }
  if (IS_BUNDLED_EXE) {
    const dir = join(dirname(process.execPath), 'ml-runtime');
    _mlRuntimeDir = existsSync(dir) ? dir : null;
    return _mlRuntimeDir;
  }
  // Dev: locate the onnxruntime-web package and point at its dist/.
  for (const from of [
    CONFIG_MODULE_DIR,
    PROJECT_ROOT,
    join(PROJECT_ROOT, 'packages', 'server'),
  ]) {
    try {
      const pkgJson = Bun.resolveSync('onnxruntime-web/package.json', from);
      const dist = join(dirname(pkgJson), 'dist');
      if (existsSync(dist)) {
        _mlRuntimeDir = dist;
        return _mlRuntimeDir;
      }
    } catch {
      /* try next base dir */
    }
  }
  _mlRuntimeDir = null;
  return _mlRuntimeDir;
}

/**
 * Resolve one onnxruntime-web artifact by file name to a path `Bun.file()` can read.
 *
 * A standalone exe has no `node_modules` and nothing beside it on disk, so the build
 * embeds the artifacts into the binary (`build/exe-bundle.js`) and hands their
 * `/$bunfs/` paths over on `globalThis.__YAAR_ML_RUNTIME`, exactly as it does for the
 * frontend. Shipping them as a side-car directory instead would break the moment the
 * binary was moved somewhere else.
 *
 * An explicit `YAAR_ML_RUNTIME_DIR` wins over the embedded copy so a newer/patched
 * onnxruntime can be pointed at without a rebuild.
 *
 * `name` must already be validated by the caller — this does no traversal checking.
 * Returns `null` when the artifact can't be located (route then 404s cleanly).
 */
export function getMlRuntimeArtifact(name: string): string | null {
  // Read the override here rather than via getMlRuntimeDir(), which memoizes on first
  // call: routing through it would make the answer depend on whether anything had
  // asked before the variable was read.
  const override = process.env.YAAR_ML_RUNTIME_DIR;
  if (override) return join(override, name);

  const embedded = (globalThis as Record<string, unknown>).__YAAR_ML_RUNTIME as
    | Record<string, string>
    | undefined;
  const hit = embedded?.[name];
  if (hit) return hit;

  const dir = getMlRuntimeDir();
  return dir ? join(dir, name) : null;
}
