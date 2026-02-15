/**
 * Codex authentication helpers.
 *
 * - hasCodexAuth()     — passive check (env var or auth.json)
 * - attemptCodexLogin() — blocking `codex login` via spawnSync
 * - ensureCodexAuth()   — check then login if needed
 */

import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawnSync } from 'child_process';

function authJsonPath(): string {
  return join(homedir(), '.codex', 'auth.json');
}

/** Returns true if OPENAI_API_KEY is set or ~/.codex/auth.json exists. */
export function hasCodexAuth(): boolean {
  if (process.env.OPENAI_API_KEY) return true;
  return existsSync(authJsonPath());
}

/**
 * Runs `codex login` (opens browser OAuth). Blocks until complete.
 * Returns hasCodexAuth() result afterward.
 */
export function attemptCodexLogin(codexBin: string): boolean {
  console.log('[codex] No authentication found. Running `codex login`...');
  const result = spawnSync(codexBin, ['login'], {
    stdio: 'inherit',
    timeout: 120_000,
  });
  if (result.error) {
    console.error('[codex] Login failed:', result.error.message);
  }
  return hasCodexAuth();
}

/**
 * Deletes ~/.codex/auth.json so the next ensureCodexAuth() triggers login.
 * No-op if the file doesn't exist.
 */
export function invalidateCodexAuth(): void {
  const path = authJsonPath();
  try {
    if (existsSync(path)) {
      unlinkSync(path);
      console.log('[codex] Removed stale auth.json');
    }
  } catch (err) {
    console.error('[codex] Failed to remove auth.json:', err);
  }
}

/**
 * Ensures Codex auth is available. If not, attempts interactive login.
 * Safe to call during startup (before HTTP server listens).
 */
export function ensureCodexAuth(codexBin: string): boolean {
  if (hasCodexAuth()) return true;
  return attemptCodexLogin(codexBin);
}
