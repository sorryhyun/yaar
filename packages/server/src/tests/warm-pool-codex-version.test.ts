/**
 * How the warm pool reacts to a codex CLI it cannot drive.
 *
 * The asymmetry is the whole point and is easy to get backwards: naming the provider
 * (`PROVIDER=codex`) must fail loudly, because silently handing back Claude gives the user a
 * different agent than they asked for; auto-detecting must fall through quietly, because an
 * unsupported codex is simply not a candidate and Claude is the correct answer.
 *
 * Driven through `getWarmPool()` with `createWarmProvider` replaced, so the assertions are
 * about `doInitialize`'s policy rather than about spawning a real app-server. `PROVIDER` is
 * scrubbed by `scripts/test/env.ts`, so each case sets exactly the environment it means.
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { getWarmPool } from '../providers/warm-pool.js';
import { CodexVersionError } from '../providers/codex/version.js';
import type { AITransport, ProviderType } from '../providers/types.js';

/** The private seam we substitute; `private` is compile-time only, so a cast reaches it. */
type PoolInternals = {
  createWarmProvider: (t: ProviderType) => Promise<AITransport | null>;
  initialized: boolean;
  initializing: boolean;
  initPromise: Promise<void> | null;
  pool: AITransport[];
  preferredProvider: ProviderType | null;
};

/** A provider stub that satisfies the pool's post-creation checks and nothing more. */
const fakeProvider = (providerType: ProviderType): AITransport =>
  ({
    providerType,
    name: providerType,
    systemPrompt: '',
    isAvailable: async () => true,
    dispose: async () => {},
    interrupt: async () => {},
    query: async function* () {},
  }) as unknown as AITransport;

/**
 * Reset the singleton to a pre-init state and install `attempt` as the creation seam.
 * Returns the provider types the pool actually tried, in order.
 */
function armPool(attempt: (t: ProviderType) => Promise<AITransport | null>): ProviderType[] {
  const pool = getWarmPool() as unknown as PoolInternals;
  const tried: ProviderType[] = [];
  pool.initialized = false;
  pool.initializing = false;
  pool.initPromise = null;
  pool.pool = [];
  pool.preferredProvider = null;
  pool.createWarmProvider = async (t: ProviderType) => {
    tried.push(t);
    return attempt(t);
  };
  return tried;
}

afterEach(() => {
  delete process.env.PROVIDER;
  const pool = getWarmPool() as unknown as PoolInternals;
  pool.initialized = false;
  pool.initializing = false;
  pool.initPromise = null;
  pool.pool = [];
  pool.preferredProvider = null;
});

describe('warm pool vs an unsupported codex', () => {
  it('rejects the boot when codex was explicitly requested', async () => {
    process.env.PROVIDER = 'codex';
    armPool(async () => {
      throw new CodexVersionError('0.144.0');
    });

    await expect(getWarmPool().initialize()).rejects.toThrow(CodexVersionError);
  });

  it('leaves the pool re-initializable after that rejection', async () => {
    // The latch bug this guards: `initializing` set without a `finally` stays true forever,
    // and every later initialize() then awaits the settled promise and reports success.
    process.env.PROVIDER = 'codex';
    armPool(async () => {
      throw new CodexVersionError('0.144.0');
    });
    await expect(getWarmPool().initialize()).rejects.toThrow(CodexVersionError);

    delete process.env.PROVIDER;
    armPool(async (t) => (t === 'claude' ? fakeProvider(t) : null));
    expect(await getWarmPool().initialize()).toBe(true);
  });

  it('skips codex and keeps booting when auto-detecting', async () => {
    const tried = armPool(async (t) => {
      if (t === 'codex') throw new CodexVersionError('0.144.0');
      return null; // claude unavailable, so the loop must reach codex
    });

    expect(await getWarmPool().initialize()).toBe(false); // no provider, but no throw
    expect(tried).toEqual(['claude', 'codex']);
  });

  it('still surfaces a non-version failure as a plain unavailable provider', async () => {
    // Only CodexVersionError gets the special treatment; everything else stays a soft failure.
    armPool(async (t) => {
      if (t === 'codex') throw new Error('app-server crashed');
      return null;
    });

    await expect(getWarmPool().initialize()).rejects.toThrow('app-server crashed');
  });
});
