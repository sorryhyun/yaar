/**
 * Provider warm pool - pre-initializes providers at startup for faster connection handling.
 *
 * Instead of creating providers on-demand when a WebSocket connection arrives,
 * this pool maintains ready-to-use provider instances that can be quickly assigned.
 *
 * For Claude, this uses ClaudeSessionProvider which sends a warmup message to
 * pre-create a session with MCP tools loaded.
 */

import type { AITransport, ProviderType } from './types.js';
import { AppServer } from './codex/app-server.js';

/**
 * Configuration for the warm pool.
 */
interface WarmPoolConfig {
  /** Number of providers to pre-warm (default: 1) */
  poolSize: number;
  /** Whether to automatically replenish used providers (default: true) */
  autoReplenish: boolean;
}

const DEFAULT_CONFIG: WarmPoolConfig = {
  poolSize: 1,
  autoReplenish: true,
};

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
 * Provider warm pool singleton.
 */
class ProviderWarmPool {
  private config: WarmPoolConfig;
  private pool: AITransport[] = [];
  private preferredProvider: ProviderType | null = null;
  private initializing = false;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private sharedCodexAppServer: AppServer | null = null;

  constructor(config: Partial<WarmPoolConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize the warm pool by pre-creating and warming up providers.
   * Should be called at server startup.
   */
  async initialize(): Promise<boolean> {
    if (this.initialized) return true;
    if (this.initializing && this.initPromise) {
      await this.initPromise;
      return this.initialized;
    }

    this.initializing = true;
    this.initPromise = this.doInitialize();
    await this.initPromise;
    this.initializing = false;
    return this.initialized;
  }

  private async doInitialize(): Promise<void> {
    console.log('[WarmPool] Initializing provider warm pool...');

    // Determine which provider to use
    const forcedProvider = getForcedProvider();
    const providerTypes: ProviderType[] = forcedProvider ? [forcedProvider] : ['claude', 'codex'];

    // Find first available provider and warm it up
    for (const providerType of providerTypes) {
      const provider = await this.createWarmProvider(providerType);
      if (provider) {
        this.preferredProvider = providerType;
        this.pool.push(provider);
        console.log(`[WarmPool] Using provider: ${providerType}`);
        break;
      }
    }

    if (this.pool.length === 0) {
      console.log('[WarmPool] No provider available');
      return;
    }

    // Pre-warm additional providers if configured
    for (let i = 1; i < this.config.poolSize; i++) {
      const provider = await this.createWarmProvider(this.preferredProvider!);
      if (provider) {
        this.pool.push(provider);
      }
    }

    console.log(`[WarmPool] Warmed ${this.pool.length} provider(s)`);
    this.initialized = true;
  }

  /**
   * Create and warm up a provider instance.
   * For Codex, WarmPool creates/starts the AppServer and passes it to the provider.
   */
  private async createWarmProvider(providerType: ProviderType): Promise<AITransport | null> {
    try {
      let provider: AITransport;

      if (providerType === 'claude') {
        // Use session provider for Claude (supports warmup)
        const { ClaudeSessionProvider } = await import('./claude/index.js');
        provider = new ClaudeSessionProvider();
      } else {
        // Ensure shared AppServer exists and is running
        await this.ensureCodexAppServer();

        const { CodexProvider } = await import('./codex/index.js');
        const codexProvider = new CodexProvider(this.sharedCodexAppServer!);
        provider = codexProvider;

        // Establish dedicated WS connection before availability check
        const warmed = await codexProvider.warmup();
        if (!warmed) {
          await provider.dispose();
          return null;
        }
      }

      // Check availability
      if (!(await provider.isAvailable())) {
        await provider.dispose();
        return null;
      }

      return provider;
    } catch (err) {
      console.error(`[WarmPool] Failed to create ${providerType} provider:`, err);
      return null;
    }
  }

  /**
   * Ensure the shared Codex AppServer is created and running.
   * WarmPool is the sole owner of this process.
   *
   * After starting, checks auth via RPC and opens browser for OAuth if needed.
   */
  private async ensureCodexAppServer(): Promise<void> {
    if (this.sharedCodexAppServer?.isRunning) {
      return;
    }

    // Stop any dead AppServer before replacing
    if (this.sharedCodexAppServer) {
      await this.sharedCodexAppServer.stop();
    }

    console.log('[WarmPool] Starting shared Codex AppServer');
    this.sharedCodexAppServer = new AppServer({ model: 'gpt-5.3-codex' });

    this.sharedCodexAppServer.on('error', (err) => {
      console.error('[WarmPool] Codex AppServer error:', err);
    });

    await this.sharedCodexAppServer.start();

    // Listen for unexpected exit so next ensureCodexAppServer() call restarts it
    this.sharedCodexAppServer.on('exit', (code, signal) => {
      if (!this.sharedCodexAppServer?.isRunning) {
        console.warn(
          `[WarmPool] Codex AppServer exited unexpectedly (code: ${code}, signal: ${signal}). Will restart on next provider creation.`,
        );
      }
    });

    // Check auth via RPC and trigger browser OAuth if needed
    const { checkAndLoginCodex } = await import('./codex/index.js');
    const authenticated = await checkAndLoginCodex(this.sharedCodexAppServer);

    if (!authenticated) {
      console.error('[WarmPool] Codex authentication failed, stopping AppServer');
      await this.sharedCodexAppServer.stop();
      this.sharedCodexAppServer = null;
    }
  }

  /**
   * Acquire a pre-warmed provider from the pool.
   * Falls back to creating a new one if pool is empty.
   */
  async acquire(): Promise<AITransport | null> {
    // Ensure initialized
    if (!this.initialized) {
      await this.initialize();
    }

    // Try to get from pool
    const provider = this.pool.shift();
    if (provider) {
      const sessionId = provider.getSessionId?.() ?? 'no-session';
      console.log(
        `[WarmPool] Acquired warm provider (session: ${sessionId}), pool size: ${this.pool.length}`,
      );

      // Replenish in background — each Codex provider now has its own WS
      // connection, so background replenish is safe for both providers.
      if (this.config.autoReplenish && this.preferredProvider) {
        this.replenishBackground();
      }

      return provider;
    }

    // Pool empty - create on demand
    if (this.preferredProvider) {
      console.log('[WarmPool] Pool empty, creating provider on demand');
      return this.createWarmProvider(this.preferredProvider);
    }

    return null;
  }

  /**
   * Replenish the pool in the background (Claude only).
   */
  private replenishBackground(): void {
    if (!this.preferredProvider || this.pool.length >= this.config.poolSize) return;

    this.createWarmProvider(this.preferredProvider)
      .then((provider) => {
        if (!provider) return;

        if (this.pool.length < this.config.poolSize) {
          this.pool.push(provider);
          const sessionId = provider.getSessionId?.() ?? 'no-session';
          console.log(
            `[WarmPool] Replenished pool (session: ${sessionId}), size: ${this.pool.length}`,
          );
        } else {
          provider.dispose();
        }
      })
      .catch((err) => {
        console.error('[WarmPool] Failed to replenish pool:', err);
      });
  }

  /**
   * Get the preferred provider type.
   */
  getPreferredProvider(): ProviderType | null {
    return this.preferredProvider;
  }

  /**
   * Check if the pool is initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get pool statistics.
   */
  getStats(): {
    poolSize: number;
    available: number;
    preferredProvider: string | null;
    warmedSessions: string[];
  } {
    return {
      poolSize: this.config.poolSize,
      available: this.pool.length,
      preferredProvider: this.preferredProvider,
      warmedSessions: this.pool
        .map((p) => p.getSessionId?.())
        .filter((id): id is string => id !== null && id !== undefined),
    };
  }

  /**
   * Dispose any pooled Codex providers so the next acquire() creates a fresh one.
   * The shared AppServer process is kept alive — only the thread references are cleared.
   * A new CodexProvider (currentSession = null) will call threadStart on first message.
   */
  async resetCodexProviders(): Promise<void> {
    const kept: AITransport[] = [];
    for (const provider of this.pool) {
      if (provider.providerType === 'codex') {
        await provider.dispose();
      } else {
        kept.push(provider);
      }
    }
    this.pool = kept;
  }

  /**
   * Clean up all pooled providers.
   */
  async cleanup(): Promise<void> {
    for (const provider of this.pool) {
      await provider.dispose();
    }
    this.pool = [];
    this.initialized = false;
    this.preferredProvider = null;
    this.sharedCodexAppServer = null;
  }
}

// Singleton instance
let warmPool: ProviderWarmPool | null = null;

/**
 * Get the global provider warm pool instance.
 */
export function getWarmPool(): ProviderWarmPool {
  if (!warmPool) {
    warmPool = new ProviderWarmPool();
  }
  return warmPool;
}

/**
 * Initialize the warm pool at startup.
 * Call this in the server startup sequence.
 */
export async function initWarmPool(): Promise<boolean> {
  return getWarmPool().initialize();
}

/**
 * Acquire a pre-warmed provider.
 * Use this instead of getFirstAvailableProvider() for faster provider acquisition.
 */
export async function acquireWarmProvider(): Promise<AITransport | null> {
  return getWarmPool().acquire();
}
