/**
 * Static asset concerns: MIME table, upload ceiling, and the onnxruntime-web
 * runtime artifacts served to app iframes.
 */

import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { CONFIG_MODULE_DIR, IS_BUNDLED_EXE, PROJECT_ROOT } from './env.js';

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
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50MB

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
 * embeds the artifacts into the binary (`build-exe-bundle.js`) and hands their
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
