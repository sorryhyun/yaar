/**
 * Tests for BrowserPool — Chrome process and tab session management.
 *
 * Mocks chrome.js (process management), cdp.js (WebSocket connections),
 * and global fetch (Chrome debug HTTP API) to test pool logic in isolation.
 * BrowserSession uses the mocked CDPClient, so no separate session mock is needed.
 */
import { mock, describe, it, expect, beforeEach, afterEach } from 'bun:test';

// ── Mock CDP client ──────────────────────────────────────────────────────────

const mockCdpSend = mock(() => Promise.resolve({}));
const mockCdpWaitForEvent = mock(() => Promise.resolve(undefined));
const mockCdpClose = mock(() => {});
const mockCdpOn = mock(() => {});

mock.module('../lib/browser/cdp.js', () => ({
  CDPClient: {
    connect: mock(() =>
      Promise.resolve({
        send: mockCdpSend,
        waitForEvent: mockCdpWaitForEvent,
        close: mockCdpClose,
        on: mockCdpOn,
      }),
    ),
  },
}));

// ── Mock chrome process management ───────────────────────────────────────────

const mockFindChrome = mock(() => Promise.resolve('/usr/bin/chrome'));
const mockKill = mock(() => {});
const mockLaunchChrome = mock(() =>
  Promise.resolve({
    port: 9222,
    process: { pid: 99999, kill: mockKill },
    wsUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
    userDataDir: '/tmp/yaar-browser-mock',
  }),
);
const mockCleanupChrome = mock(() => Promise.resolve(undefined));
const mockCleanupStaleChrome = mock(() => Promise.resolve(undefined));
const mockWritePidFile = mock(() => Promise.resolve(undefined));
const mockRemovePidFile = mock(() => Promise.resolve(undefined));

mock.module('../lib/browser/chrome.js', () => ({
  findChrome: mockFindChrome,
  launchChrome: mockLaunchChrome,
  cleanupChrome: mockCleanupChrome,
  cleanupStaleChrome: mockCleanupStaleChrome,
  writePidFile: mockWritePidFile,
  removePidFile: mockRemovePidFile,
}));

// ── Mock global fetch for Chrome debug HTTP API ──────────────────────────────

const _originalFetch = globalThis.fetch;
const mockFetch = mock(() =>
  Promise.resolve({
    ok: true,
    json: () =>
      Promise.resolve({
        id: 'tab-mock',
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/mock',
      }),
  }),
) as any;
globalThis.fetch = mockFetch;

// Import after mocks are set up
const { BrowserPool } = await import('../lib/browser/pool.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

function internals(pool: InstanceType<typeof BrowserPool>) {
  return pool as unknown as {
    sessions: Map<string, unknown>;
    chrome: unknown;
    cleanupIdle: () => Promise<void>;
    cleanupTimer: ReturnType<typeof setInterval> | null;
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('BrowserPool', () => {
  let pool: InstanceType<typeof BrowserPool>;

  beforeEach(() => {
    mockFindChrome.mockClear();
    mockLaunchChrome.mockClear();
    mockCleanupChrome.mockClear();
    mockCleanupStaleChrome.mockClear();
    mockWritePidFile.mockClear();
    mockCdpSend.mockClear();
    mockCdpClose.mockClear();
    mockFetch.mockClear();
    // Reset CDP send to return empty objects by default
    mockCdpSend.mockImplementation(() => Promise.resolve({}));
    pool = new BrowserPool();
  });

  afterEach(async () => {
    await pool.shutdown();
  });

  it('createSession auto-assigns browserId', async () => {
    const { session, browserId } = await pool.createSession();

    expect(browserId).toBe('0');
    expect(session).toBeDefined();
    expect(session.id).toBe('0');
    expect(pool.getSession('0')).toBe(session);

    expect(mockLaunchChrome).toHaveBeenCalledTimes(1);

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

  it('enforces max sessions limit (5)', async () => {
    await pool.createSession();
    await pool.createSession();
    await pool.createSession();
    await pool.createSession();
    await pool.createSession();

    const err = await pool.createSession().catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/limit reached/i);
    expect(pool.getStats().activeSessions).toBe(5);
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
    expect(mockCleanupChrome).toHaveBeenCalled();
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
    await pool.createSession();
    await pool.createSession();
    await pool.createSession();

    await pool.shutdown();

    expect(pool.getStats().activeSessions).toBe(0);
    expect(pool.getStats().chromeRunning).toBe(false);
    expect(mockCleanupChrome).toHaveBeenCalled();
  });

  it('cleans up stale Chrome before launching', async () => {
    await pool.createSession();

    expect(mockCleanupStaleChrome).toHaveBeenCalledTimes(1);
    expect(mockWritePidFile).toHaveBeenCalledTimes(1);
    expect(mockWritePidFile).toHaveBeenCalledWith(
      expect.objectContaining({ port: 9222, userDataDir: '/tmp/yaar-browser-mock' }),
    );
  });

  it('does not call stale cleanup on subsequent sessions (Chrome already running)', async () => {
    await pool.createSession();
    expect(mockCleanupStaleChrome).toHaveBeenCalledTimes(1);

    mockCleanupStaleChrome.mockClear();
    await pool.createSession();
    expect(mockCleanupStaleChrome).not.toHaveBeenCalled();
  });

  it('idle cleanup removes stale sessions', async () => {
    const freshPool = new BrowserPool();
    const { session: s1 } = await freshPool.createSession();
    const { session: s2 } = await freshPool.createSession();

    // Make s1 appear idle (6 minutes ago)
    s1.lastActivity = Date.now() - 6 * 60 * 1000;
    s2.lastActivity = Date.now();

    await internals(freshPool).cleanupIdle();

    expect(freshPool.getSession('0')).toBeUndefined();
    expect(freshPool.getSession('1')).toBe(s2);
    expect(freshPool.getStats().activeSessions).toBe(1);
    expect(freshPool.getStats().chromeRunning).toBe(true);

    await freshPool.shutdown();
  });
});
