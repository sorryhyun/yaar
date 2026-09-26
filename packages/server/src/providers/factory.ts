/**
 * Provider availability detection, plus the warm-pool entry points.
 *
 * Construction lives in `instantiate.ts` and acquisition in `warm-pool.ts`; this
 * module answers "which providers could run here" (`GET /api/providers`) and
 * re-exports the pool so callers import one module. Dynamic imports keep SDK
 * dependencies unloaded until needed.
 */

import type { ProviderType } from './types.js';
import { PROVIDER_PREFERENCE, instantiateProvider } from './instantiate.js';
import { cliVersionOutput } from './cli-probe.js';
import { createLogger } from '../observability/log.js';

const log = createLogger('providers');

/**
 * Lightweight availability checkers per provider.
 * These don't instantiate full providers — just check prerequisites.
 */
const availabilityCheckers: Record<ProviderType, () => Promise<boolean>> = {
  claude: async () => {
    const p = await instantiateProvider('claude');
    try {
      return await p.isAvailable();
    } finally {
      await p.dispose();
    }
  },
  codex: async () => {
    // Check CLI + auth without needing an AppServer
    // Passive check only — must NOT block with login (called by GET /api/providers)
    try {
      const { getCodexSpawnArgs } = await import('../config.js');
      // Shares the per-boot probe cache with the providers' own checks, and
      // never blocks the event loop — this process serves the MCP endpoints
      // the CLI it is probing will connect back to.
      const versionOutput = await cliVersionOutput(...getCodexSpawnArgs());
      if (versionOutput === null) return false;

      // An under-versioned codex counts as *unavailable*, not as a fallback worth
      // trying: auto-detect should pick Claude rather than boot into a provider whose
      // protocol bindings no longer describe it. Explicitly forcing PROVIDER=codex
      // bypasses this checker and gets a hard error from the AppServer handshake instead.
      const { CODEX_MIN_VERSION, isAtLeast, parseVersionOutput } =
        await import('./codex/version.js');
      const version = parseVersionOutput(versionOutput);
      // Unparseable → fail open. The version string is OpenAI's to reformat, and a
      // cosmetic change there must not un-detect a working install.
      if (version && isAtLeast(version, CODEX_MIN_VERSION) === false) {
        log.warn('ignoring codex: version below minimum', {
          version,
          required: CODEX_MIN_VERSION,
        });
        return false;
      }
    } catch {
      return false;
    }
    const { hasCodexAuth } = await import('./codex/auth.js');
    return hasCodexAuth();
  },
};

/**
 * Get list of available provider names.
 */
export async function getAvailableProviders(): Promise<ProviderType[]> {
  const available: ProviderType[] = [];

  for (const providerType of PROVIDER_PREFERENCE) {
    const checker = availabilityCheckers[providerType];
    if (!checker) continue;

    if (await checker()) {
      available.push(providerType);
    }
  }

  return available;
}

// Re-export warm pool functions for convenient access
export { initWarmPool, acquireWarmProvider, getWarmPool } from './warm-pool.js';
