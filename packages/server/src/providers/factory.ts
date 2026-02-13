/**
 * Provider factory for creating AI provider instances.
 *
 * Uses dynamic imports to avoid loading SDK dependencies until needed.
 */

import type { AITransport, ProviderType, ProviderInfo } from './types.js';
import { getWarmPool } from './warm-pool.js';

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
 * Preference order for auto-selecting providers.
 */
const PROVIDER_PREFERENCE: ProviderType[] = ['claude', 'codex'];

/**
 * Get forced provider from environment variable.
 */
function getForcedProvider(): ProviderType | null {
  const provider = process.env.PROVIDER?.toLowerCase();
  if (provider && (provider === 'claude' || provider === 'codex')) {
    return provider;
  }
  return null;
}

/**
 * Lightweight availability checkers per provider.
 * These don't instantiate full providers — just check prerequisites.
 */
const availabilityCheckers: Record<ProviderType, () => Promise<boolean>> = {
  claude: async () => {
    const { ClaudeSessionProvider } = await import('./claude/index.js');
    const p = new ClaudeSessionProvider();
    try {
      return await p.isAvailable();
    } finally {
      await p.dispose();
    }
  },
  codex: async () => {
    // Check CLI + auth without needing an AppServer
    // Use getCodexBin() to find the binary (supports bundled exe mode)
    try {
      const { execSync } = await import('child_process');
      const { getCodexBin } = await import('../config.js');
      execSync(`"${getCodexBin()}" --version`, { stdio: 'ignore' });
    } catch {
      return false;
    }
    if (process.env.OPENAI_API_KEY) return true;
    try {
      const os = await import('os');
      const fs = await import('fs/promises');
      const path = await import('path');
      const authPath = path.join(os.homedir(), '.codex', 'auth.json');
      await fs.access(authPath);
      return true;
    } catch {
      return false;
    }
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
  if (providerType === 'claude') {
    const { ClaudeSessionProvider } = await import('./claude/index.js');
    return new ClaudeSessionProvider();
  }
  if (providerType === 'codex') {
    // Codex providers must go through the warm pool (which owns the AppServer)
    const provider = await getWarmPool().acquire();
    if (!provider) throw new Error('Failed to create Codex provider');
    return provider;
  }
  throw new Error(`Unknown provider: ${providerType}`);
}

/**
 * Get the first available provider.
 * If PROVIDER env var is set, only that provider is used.
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
