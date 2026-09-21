/**
 * The onnxruntime-web version the `yaar-ml` shim is compiled against.
 *
 * The server serves ORT's artifacts at `/api/ml-runtime/<file>` with a one-year
 * `immutable` cache lifetime, and the file names do not change between releases. So an
 * unversioned URL pins a browser to whichever ORT it fetched first: bumping the package
 * reaches the server and nothing past it. The shim therefore puts this version on every
 * runtime URL it hands out (`?v=`) — a new version is a new cache key — and the build
 * manifest records it so a yaar-ml app goes stale when ORT moves.
 *
 * Null when ORT is not resolvable from `node_modules`, which is the exe: there the shim
 * is prebundled at release time with the version baked in, and nothing recompiles it.
 */

import { readFileSync } from 'fs';
import { MODULE_ROOT } from '../paths.js';

let cached: string | null | undefined;

export function getOrtVersion(): string | null {
  if (cached !== undefined) return cached;
  try {
    const pkgJson = Bun.resolveSync('onnxruntime-web/package.json', MODULE_ROOT);
    const { version } = JSON.parse(readFileSync(pkgJson, 'utf8')) as { version?: unknown };
    cached = typeof version === 'string' ? version : null;
  } catch {
    cached = null;
  }
  return cached;
}

/** The `Bun.build` `define` that stamps the version into the shim's `__YAAR_ORT_VERSION__`. */
export function ortVersionDefine(): Record<string, string> {
  return { __YAAR_ORT_VERSION__: JSON.stringify(getOrtVersion() ?? '') };
}
