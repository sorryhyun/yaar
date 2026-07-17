/**
 * Provider factory for creating AI provider instances.
 *
 * Uses dynamic imports to avoid loading SDK dependencies until needed.
 */

import type { AITransport, ProviderType, ProviderInfo } from './types.js';
import { getWarmPool } from './warm-pool.js';
import { getForcedProvider } from './get-forced-provider.js';
import { PROVIDER_PREFERENCE, instantiateProvider } from './instantiate.js';
import { isCliAvailable } from './base-transport.js';

/**
 * Registry of available providers with metadata.
 */
export const providerRegistry: Record<ProviderType, ProviderInfo> = {
  claude: {
    type: 'claude',
    displayName: 'Claude',
    description: 'Anthropic Claude via Agent SDK',
    requiredCli: 'claude',
  },
  codex: {
    type: 'codex',
    displayName: 'Codex',
    description: 'OpenAI Codex agent',
    requiredCli: 'codex',
    // No requiredEnvVars - supports both API key and OAuth auth
  },
};

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
      if (!(await isCliAvailable(...getCodexSpawnArgs()))) return false;
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

/**
 * Create a provider instance by provider type.
 * Claude: creates directly. Codex: uses warm pool (AppServer required).
 */
export async function createProvider(providerType: ProviderType): Promise<AITransport> {
  if (providerType === 'codex') {
    // Codex providers must go through the warm pool (which owns the AppServer),
    // so this is the one construction the shared helper can't do for us.
    const provider = await getWarmPool().acquire();
    if (!provider) throw new Error('Failed to create Codex provider');
    return provider;
  }
  return instantiateProvider(providerType);
}

/**
 * Get the first available provider.
 * If PROVIDER env var or settings.json provider is set, only that provider is tried.
 * Returns null if no providers are available.
 */
export async function getFirstAvailableProvider(): Promise<AITransport | null> {
  const forcedProvider = getForcedProvider();
  const providers = forcedProvider ? [forcedProvider] : PROVIDER_PREFERENCE;

  for (const providerType of providers) {
    const checker = availabilityCheckers[providerType];
    if (!checker) continue;

    if (await checker()) {
      return createProvider(providerType);
    }
  }

  return null;
}

/**
 * Get provider info by type.
 */
export function getProviderInfo(providerType: ProviderType): ProviderInfo | undefined {
  return providerRegistry[providerType];
}

/**
 * Get all provider info.
 */
export function getAllProviderInfo(): ProviderInfo[] {
  return Object.values(providerRegistry);
}

// Re-export warm pool functions for convenient access
export { initWarmPool, acquireWarmProvider, getWarmPool } from './warm-pool.js';
