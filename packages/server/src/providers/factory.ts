/**
 * Provider factory for creating AI provider instances.
 *
 * Uses dynamic imports to avoid loading SDK dependencies until needed.
 */

import type { AITransport, ProviderType, ProviderInfo } from './types.js';

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
 * Dynamic import loaders for each provider.
 * This keeps SDK dependencies from being loaded until actually needed.
 */
const providerLoaders: Record<ProviderType, () => Promise<AITransport>> = {
  claude: async () => {
    const { ClaudeProvider } = await import('./claude/index.js');
    return new ClaudeProvider();
  },
  codex: async () => {
    const { CodexProvider } = await import('./codex/index.js');
    return new CodexProvider();
  },
};

/**
 * Get list of available provider names.
 */
export async function getAvailableProviders(): Promise<ProviderType[]> {
  const available: ProviderType[] = [];

  for (const providerType of PROVIDER_PREFERENCE) {
    const loader = providerLoaders[providerType];
    if (!loader) continue;

    const provider = await loader();
    try {
      if (await provider.isAvailable()) {
        available.push(providerType);
      }
    } finally {
      await provider.dispose();
    }
  }

  return available;
}

/**
 * Create a provider instance by provider type.
 * Uses dynamic imports to only load the required SDK.
 */
export async function createProvider(providerType: ProviderType): Promise<AITransport> {
  const loader = providerLoaders[providerType];
  if (!loader) {
    throw new Error(`Unknown provider: ${providerType}`);
  }
  return loader();
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
    const loader = providerLoaders[providerType];
    if (!loader) continue;

    const provider = await loader();
    if (await provider.isAvailable()) {
      return provider;
    }
    await provider.dispose();
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
