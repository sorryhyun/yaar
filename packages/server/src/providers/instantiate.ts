/**
 * Provider construction, single-sourced.
 *
 * `factory.ts` and `warm-pool.ts` each used to carry their own copy of the
 * preference order and their own `new XProvider()` switch, so adding a provider
 * meant editing both and a missed one drifted silently. The *construction* is
 * shared here; what each caller does afterwards is not, and stays with them —
 * the warm pool warms and probes its instances, while the factory hands Codex
 * off to the pool entirely (the pool owns the AppServer).
 *
 * Dynamic imports keep the SDK dependencies lazy.
 */

import type { AITransport, ProviderType } from './types.js';
import type { AppServer } from './codex/app-server.js';

/**
 * Preference order for auto-selecting providers (claude first).
 *
 * `readonly` because two modules now iterate the same array — a splice in one
 * would silently reorder the other's fallback.
 */
export const PROVIDER_PREFERENCE: readonly ProviderType[] = ['claude', 'codex'];

/**
 * Construct a bare provider instance — no warmup, no availability check.
 *
 * @param appServer - The running AppServer a Codex provider talks through.
 *   Deliberately nullable: when the pool's Codex auth fails it has no AppServer
 *   to give, and the graceful path is for the provider to be built anyway and
 *   refuse itself from `warmup()`. Ignored for Claude.
 */
export async function instantiateProvider(
  providerType: ProviderType,
  appServer?: AppServer | null,
): Promise<AITransport> {
  switch (providerType) {
    case 'claude': {
      const { ClaudeSessionProvider } = await import('./claude/index.js');
      return new ClaudeSessionProvider();
    }
    case 'codex': {
      const { CodexProvider } = await import('./codex/index.js');
      return new CodexProvider(appServer as AppServer);
    }
    default:
      throw new Error(`Unknown provider: ${providerType}`);
  }
}
