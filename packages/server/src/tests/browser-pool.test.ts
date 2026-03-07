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
    process: { pid: 99999, kill: vi.fn() },
    wsUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
    userDataDir: '/tmp/yaar-browser-mock',
  }),
  cleanupChrome: vi.fn().mockResolvedValue(undefined),
  cleanupStaleChrome: vi.fn().mockResolvedValue(undefined),
  writePidFile: vi.fn().mockResolvedValue(undefined),
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
import { cleanupChrome, cleanupStaleChrome, writePidFile } from '../lib/browser/chrome.js';
import { BrowserSession } from '../lib/browser/session.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

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
    await pool.shutdown();
    vi.restoreAllMocks();
  });

  it('createSession auto-assigns browserId', async () => {
    const { session, browserId } = await pool.createSession();

    expect(browserId).toBe('0');
    expect(session).toBeDefined();
    expect(session.id).toBe('0');
    expect(pool.getSession('0')).toBe(session);
    expect(BrowserSession.create).toHaveBeenCalledWith(
      '0',
      'ws://127.0.0.1:9222/devtools/page/mock',
    );

    const { launchChrome } = await import('../lib/browser/chrome.js');
    expect(launchChrome).toHaveBeenCalledOnce();

    expect(globalThis.fetch).toHaveBeenCalledWith('http://127.0.0.1:9222/json/new?about:blank', {
      method: 'PUT',
      signal: expect.any(AbortSignal),
    });

    const stats = pool.getStats();
    expect(stats.activeSessions).toBe(1);
    expect(stats.chromeRunning).toBe(true);
  });

  it('auto-increments browserId', async () => {
    const r1 = await pool.createSession();
    const r2 = await pool.createSession();

    expect(r1.browserId).toBe('0');
    expect(r2.browserId).toBe('1');
  });

  it('accepts explicit browserId', async () => {
    const { browserId } = await pool.createSession('custom');
    expect(browserId).toBe('custom');
    expect(pool.getSession('custom')).toBeDefined();
  });

  it('enforces max sessions limit (3)', async () => {
    await pool.createSession();
    await pool.createSession();
    await pool.createSession();

    await expect(pool.createSession()).rejects.toThrow(/limit reached/i);
    expect(pool.getStats().activeSessions).toBe(3);
  });

  it('findByWindowId returns the correct session', async () => {
    const { session: s1 } = await pool.createSession();
    const { session: s2 } = await pool.createSession();

    s1.windowId = 'win-abc';
    s2.windowId = 'win-xyz';

    expect(pool.findByWindowId('win-abc')).toBe(s1);
    expect(pool.findByWindowId('win-xyz')).toBe(s2);
    expect(pool.findByWindowId('win-nonexistent')).toBeUndefined();
  });

  it('closeSession removes session and kills Chrome when last', async () => {
    await pool.createSession();
    expect(pool.getStats().activeSessions).toBe(1);

    await pool.closeSession('0');

    expect(pool.getSession('0')).toBeUndefined();
    expect(pool.getStats().activeSessions).toBe(0);
    expect(cleanupChrome).toHaveBeenCalled();
    expect(pool.getStats().chromeRunning).toBe(false);
  });

  it('getAllSessions returns all open browsers', async () => {
    await pool.createSession();
    await pool.createSession();

    const all = pool.getAllSessions();
    expect(all.size).toBe(2);
    expect(all.has('0')).toBe(true);
    expect(all.has('1')).toBe(true);
  });

  it('shutdown closes all sessions and Chrome', async () => {
    const { session: s1 } = await pool.createSession();
    const { session: s2 } = await pool.createSession();
    const { session: s3 } = await pool.createSession();

    await pool.shutdown();

    expect(s1.close).toHaveBeenCalled();
    expect(s2.close).toHaveBeenCalled();
    expect(s3.close).toHaveBeenCalled();

    expect(pool.getStats().activeSessions).toBe(0);
    expect(pool.getStats().chromeRunning).toBe(false);
    expect(cleanupChrome).toHaveBeenCalled();
  });

  it('cleans up stale Chrome before launching', async () => {
    await pool.createSession();

    expect(cleanupStaleChrome).toHaveBeenCalledOnce();
    expect(writePidFile).toHaveBeenCalledOnce();
    expect(writePidFile).toHaveBeenCalledWith(
      expect.objectContaining({ port: 9222, userDataDir: '/tmp/yaar-browser-mock' }),
    );
  });

  it('does not call stale cleanup on subsequent sessions (Chrome already running)', async () => {
    await pool.createSession();
    expect(cleanupStaleChrome).toHaveBeenCalledOnce();

    vi.mocked(cleanupStaleChrome).mockClear();
    await pool.createSession();
    expect(cleanupStaleChrome).not.toHaveBeenCalled();
  });

  it('idle cleanup removes stale sessions', async () => {
    vi.useFakeTimers();
    try {
      const freshPool = new BrowserPool();
      const { session: s1 } = await freshPool.createSession();
      const { session: s2 } = await freshPool.createSession();

      // Make s1 appear idle (6 minutes ago)
      s1.lastActivity = Date.now() - 6 * 60 * 1000;
      s2.lastActivity = Date.now();

      await internals(freshPool).cleanupIdle();

      expect(freshPool.getSession('0')).toBeUndefined();
      expect(freshPool.getSession('1')).toBe(s2);
      expect(s1.close).toHaveBeenCalled();
      expect(s2.close).not.toHaveBeenCalled();
      expect(freshPool.getStats().activeSessions).toBe(1);
      expect(freshPool.getStats().chromeRunning).toBe(true);

      await freshPool.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });
});
