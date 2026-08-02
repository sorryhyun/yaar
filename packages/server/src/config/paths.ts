/**
 * Filesystem locations derived from `PROJECT_ROOT` and the environment.
 */

import { join, dirname } from 'path';
import { IS_BUNDLED_EXE, PROJECT_ROOT } from './env.js';

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
 * Get the session-log directory path.
 * - Environment variable override
 * - Otherwise: PROJECT_ROOT/session_logs/
 *
 * The override exists for the same reason `YAAR_STORAGE`'s does: a test run must not
 * write into the working tree. Anything that builds a `SessionLogger` mints a directory
 * here, and a suite that exercises app agents or sub-agents does exactly that — which is
 * how `session_logs/` filled up with `app-persona-…` logs from `bun run test`.
 * `scripts/test/env.ts` points this at a temp dir alongside the other two.
 */
export function getSessionLogsDir(): string {
  if (process.env.YAAR_SESSION_LOGS) {
    return process.env.YAAR_SESSION_LOGS;
  }
  return join(PROJECT_ROOT, 'session_logs');
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
