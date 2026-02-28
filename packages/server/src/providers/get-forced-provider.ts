/**
 * Shared helper to determine the forced provider from env var or settings.
 * Extracted to its own module to avoid circular imports between factory.ts and warm-pool.ts.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import type { ProviderType } from './types.js';
import { getConfigDir } from '../config.js';

/**
 * Get forced provider from environment variable or config/settings.json.
 * Priority: PROVIDER env var > settings.json provider field > auto-detect (null).
 */
export function getForcedProvider(): ProviderType | null {
  // 1. Check environment variable
  const envProvider = process.env.PROVIDER?.toLowerCase();
  if (envProvider && (envProvider === 'claude' || envProvider === 'codex')) {
    return envProvider;
  }

  // 2. Check config/settings.json
  try {
    const settingsPath = join(getConfigDir(), 'settings.json');
    const raw = readFileSync(settingsPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const settingsProvider = parsed.provider;
    if (settingsProvider === 'claude' || settingsProvider === 'codex') {
      return settingsProvider;
    }
  } catch {
    // No settings file or invalid JSON — fall through to auto-detect
  }

  return null;
}
