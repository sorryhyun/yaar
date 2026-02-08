/**
 * Server configuration — constants, paths, MIME types.
 */

import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Detect if running as bundled executable
// __YAAR_BUNDLED is injected at compile time via bun build --define
declare const __YAAR_BUNDLED: boolean | undefined;
export const IS_BUNDLED_EXE = typeof __YAAR_BUNDLED !== 'undefined' && __YAAR_BUNDLED;

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Project root directory.
 * - Bundled exe: directory containing the executable
 * - Development: 3 levels up from src/ (packages/server/src → project root)
 */
export const PROJECT_ROOT = IS_BUNDLED_EXE
  ? dirname(process.execPath)
  : join(__dirname, '..', '..', '..');

/**
 * Get the storage directory path.
 * - Environment variable override
 * - Otherwise: PROJECT_ROOT/storage/ (works for both bundled and dev)
 */
export function getStorageDir(): string {
  if (process.env.YAAR_STORAGE) {
    return process.env.YAAR_STORAGE;
  }
  return join(PROJECT_ROOT, 'storage');
}

export const STORAGE_DIR = getStorageDir();

/**
 * Get the config directory path.
 * - Environment variable override
 * - Always relative to PROJECT_ROOT
 */
export function getConfigDir(): string {
  if (process.env.YAAR_CONFIG) {
    return process.env.YAAR_CONFIG;
  }
  return join(PROJECT_ROOT, 'config');
}

/**
 * Get the frontend dist directory path.
 * - Environment variable override
 * - Bundled exe: ./public/ alongside executable
 * - Development: packages/frontend/dist/
 */
export function getFrontendDist(): string {
  if (process.env.FRONTEND_DIST) {
    return process.env.FRONTEND_DIST;
  }
  if (IS_BUNDLED_EXE) {
    return join(dirname(process.execPath), 'public');
  }
  return join(PROJECT_ROOT, 'packages', 'frontend', 'dist');
}

export const FRONTEND_DIST = getFrontendDist();

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
};

export const PORT = parseInt(process.env.PORT ?? '8000', 10);

/** Known codex binary filename for Windows */
const CODEX_EXE_NAME = 'codex-x86_64-pc-windows-msvc.exe';

/**
 * Get the codex CLI binary path.
 * - Bundled exe: look next to the exe, then ../bundled/
 * - Development: 'codex' (from PATH)
 */
export function getCodexBin(): string {
  if (IS_BUNDLED_EXE) {
    const exeDir = dirname(process.execPath);
    // 1. Next to the exe
    const beside = join(exeDir, CODEX_EXE_NAME);
    if (existsSync(beside)) return beside;
    // 2. ../bundled/ (exe is in dist/, bundled/ is a sibling)
    const bundled = join(exeDir, '..', 'bundled', CODEX_EXE_NAME);
    if (existsSync(bundled)) return bundled;
  }
  return 'codex';
}
