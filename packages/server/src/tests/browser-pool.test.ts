/**
 * Tests for BrowserPool — Chrome process and tab session management.
 *
 * Mocks the chrome and session modules to test pool logic in isolation:
 * session creation, max limit enforcement, lookup, cleanup, and shutdown.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../lib/browser/chrome.js', () => ({
  findChrome: vi.fn().mockResolvedValue('/usr/bin/chrome'),
  launchChrome: vi.fn().mockResolvedValue({
    port: 9222,
    process: { kill: vi.fn() },
    wsUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
    userDataDir: '/tmp/yaar-browser-mock',
  }),
  cleanupChrome: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/browser/session.js', () => ({
  BrowserSession: {
    create: vi.fn().mockImplementation((id: string, _debuggerUrl: string) => {
      return Promise.resolve({
        id,
        windowId: undefined,
        lastActivity: Date.now(),
        close: vi.fn().mockResolvedValue(undefined),
      });
    }),
  },
}));

// Mock global fetch for Chrome debug HTTP API (/json/new)
vi.stubGlobal(
  'fetch',
  vi.fn().mockResolvedValue({
    ok: true,
    json: () =>
      Promise.resolve({
        id: 'tab-mock',
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/mock',
      }),
  }),
);

// Import after mocks are set up
import { BrowserPool } from '../lib/browser/pool.js';
import { cleanupChrome } from '../lib/browser/chrome.js';
import { BrowserSession } from '../lib/browser/session.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Access private members of BrowserPool for test assertions.
 */
function internals(pool: BrowserPool) {
  return pool as unknown as {
    sessions: Map<string, unknown>;
    chrome: unknown;
    cleanupIdle: () => Promise<void>;
    cleanupTimer: ReturnType<typeof setInterval> | null;
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('BrowserPool', () => {
  let pool: BrowserPool;

  beforeEach(() => {
    vi.clearAllMocks();
    pool = new BrowserPool();
  });

  afterEach(async () => {
    // Ensure Chrome cleanup timer does not leak across tests
    await pool.shutdown();
    vi.restoreAllMocks();
  });

  it('createSession succeeds and stores session', async () => {
    const session = await pool.createSession('sess-1');

    expect(session).toBeDefined();
    expect(session.id).toBe('sess-1');
    expect(pool.getSession('sess-1')).toBe(session);
    expect(BrowserSession.create).toHaveBeenCalledWith(
      'sess-1',
      'ws://127.0.0.1:9222/devtools/page/mock',
    );

    // Chrome was launched lazily
    const { launchChrome } = await import('../lib/browser/chrome.js');
    expect(launchChrome).toHaveBeenCalledOnce();

    // Fetch was called for /json/new
    expect(globalThis.fetch).toHaveBeenCalledWith('http://127.0.0.1:9222/json/new?about:blank', {
      method: 'PUT',
    });

    const stats = pool.getStats();
    expect(stats.activeSessions).toBe(1);
    expect(stats.chromeRunning).toBe(true);
  });

  it('enforces max sessions limit (3)', async () => {
    await pool.createSession('a');
    await pool.createSession('b');
    await pool.createSession('c');

    await expect(pool.createSession('d')).rejects.toThrow(/session limit reached/i);

    expect(pool.getStats().activeSessions).toBe(3);
  });

  it('findByWindowId returns the correct session', async () => {
    const s1 = await pool.createSession('s1');
    const s2 = await pool.createSession('s2');

    // Simulate binding window IDs (normally done externally)
    s1.windowId = 'win-abc';
    s2.windowId = 'win-xyz';

    expect(pool.findByWindowId('win-abc')).toBe(s1);
    expect(pool.findByWindowId('win-xyz')).toBe(s2);
    expect(pool.findByWindowId('win-nonexistent')).toBeUndefined();
  });

  it('closeSession removes session and kills Chrome when last', async () => {
    await pool.createSession('only');
    expect(pool.getStats().activeSessions).toBe(1);

    await pool.closeSession('only');

    expect(pool.getSession('only')).toBeUndefined();
    expect(pool.getStats().activeSessions).toBe(0);
    // Chrome should be cleaned up when no sessions remain
    expect(cleanupChrome).toHaveBeenCalled();
    expect(pool.getStats().chromeRunning).toBe(false);
  });

  it('shutdown closes all sessions and Chrome', async () => {
    const s1 = await pool.createSession('s1');
    const s2 = await pool.createSession('s2');
    const s3 = await pool.createSession('s3');

    await pool.shutdown();

    // All session close() methods were called
    expect(s1.close).toHaveBeenCalled();
    expect(s2.close).toHaveBeenCalled();
    expect(s3.close).toHaveBeenCalled();

    expect(pool.getStats().activeSessions).toBe(0);
    expect(pool.getStats().chromeRunning).toBe(false);
    expect(cleanupChrome).toHaveBeenCalled();
  });

  it('idle cleanup removes stale sessions', async () => {
    vi.useFakeTimers();
    try {
      const freshPool = new BrowserPool();
      const s1 = await freshPool.createSession('stale');
      const s2 = await freshPool.createSession('fresh');

      // Make s1 appear idle (6 minutes ago, beyond the 5-minute timeout)
      s1.lastActivity = Date.now() - 6 * 60 * 1000;
      // s2 stays fresh (activity is now)
      s2.lastActivity = Date.now();

      // Invoke the private cleanupIdle method directly
      await internals(freshPool).cleanupIdle();

      // Stale session removed, fresh session kept
      expect(freshPool.getSession('stale')).toBeUndefined();
      expect(freshPool.getSession('fresh')).toBe(s2);
      expect(s1.close).toHaveBeenCalled();
      expect(s2.close).not.toHaveBeenCalled();

      expect(freshPool.getStats().activeSessions).toBe(1);

      // Chrome still running because one session remains
      expect(freshPool.getStats().chromeRunning).toBe(true);

      await freshPool.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });
});
