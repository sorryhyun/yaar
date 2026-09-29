/**
 * Where the desktop window's native WebView library is on this machine, if anywhere.
 *
 * Three sources, first hit wins:
 *
 *  1. `YAAR_WEBVIEW_LIB` — an explicit path, for trying a freshly built library against an
 *     installed binary.
 *  2. The exe's embedded copy (`__YAAR_NATIVE`, published by `exe-assets.ts`). `dlopen`
 *     cannot read Bun's virtual filesystem, so it is written out to the user's cache
 *     directory first, under a name carrying a hash of its bytes: a new build never loads
 *     an old library, and a second launch of the same build writes nothing.
 *  3. A source checkout's build output, `dist/native/…` (`scripts/build/webview-native.ts`).
 *
 * Deliberately free of server imports beyond `config/env.ts`: the window process
 * (`host.ts`) calls this, and it boots nothing else.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { IS_BUNDLED_EXE, PROJECT_ROOT } from '../config/env.js';

/** The library's file name per platform. Absent: no WebView host there yet. */
const LIBRARY_FILE: Partial<Record<NodeJS.Platform, { dir: string; file: string }>> = {
  darwin: { dir: 'macos', file: 'libwebview.dylib' },
};

function libraryFile(): { dir: string; file: string } | null {
  return LIBRARY_FILE[process.platform] ?? null;
}

function embeddedNative(): Record<string, string> {
  return ((globalThis as Record<string, unknown>).__YAAR_NATIVE as Record<string, string>) ?? {};
}

/** The per-user cache directory the embedded library is extracted into. */
function cacheDir(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'YAAR');
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'YAAR', 'Cache');
  }
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'yaar');
}

/**
 * Could this process get a library, without writing anything? The server asks this
 * before spawning a window process that would only fail to find one.
 */
export function hasWebviewLibrary(): boolean {
  if (process.env.YAAR_WEBVIEW_LIB) return existsSync(process.env.YAAR_WEBVIEW_LIB);
  const lib = libraryFile();
  if (!lib) return false;
  if (embeddedNative()[lib.file]) return true;
  return !IS_BUNDLED_EXE && existsSync(join(PROJECT_ROOT, 'dist', 'native', lib.dir, lib.file));
}

/** A loadable path to the library, extracting the embedded copy if need be, or null. */
export function resolveWebviewLibrary(): string | null {
  const override = process.env.YAAR_WEBVIEW_LIB;
  if (override) return existsSync(override) ? override : null;

  const lib = libraryFile();
  if (!lib) return null;

  const embedded = embeddedNative()[lib.file];
  if (embedded) {
    const bytes = readFileSync(embedded);
    const hash = Bun.hash(bytes).toString(16).padStart(16, '0');
    const dot = lib.file.lastIndexOf('.');
    const dest = join(cacheDir(), `${lib.file.slice(0, dot)}-${hash}${lib.file.slice(dot)}`);
    if (!existsSync(dest)) {
      mkdirSync(cacheDir(), { recursive: true });
      // Write-then-rename, so a concurrent launch never dlopens a half-written file.
      const tmp = `${dest}.${process.pid}.tmp`;
      writeFileSync(tmp, bytes);
      renameSync(tmp, dest);
    }
    return dest;
  }

  if (IS_BUNDLED_EXE) return null;
  const built = join(PROJECT_ROOT, 'dist', 'native', lib.dir, lib.file);
  return existsSync(built) ? built : null;
}
