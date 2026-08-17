/**
 * Tests for BrowserPool — Chrome process and tab session management.
 *
 * Mocks chrome.js (process management), cdp.js (WebSocket connections),
 * and global fetch (Chrome debug HTTP API) to test pool logic in isolation.
 * BrowserSession uses the mocked CDPClient, so no separate session mock is needed.
 */
import { mock, describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// ── Mock CDP client ──────────────────────────────────────────────────────────

const mockCdpSend = mock(() => Promise.resolve({}));
const mockCdpWaitForEvent = mock(() => Promise.resolve(undefined));
const mockCdpClose = mock(() => {});
const mockCdpOn = mock(() => {});
const mockCdpOff = mock(() => {});
/** Crash watch: `BrowserSession` arms one per socket. Never fired by these tests. */
const mockCdpOnClose = mock(() => {});

mock.module('../lib/browser/cdp.js', () => ({
  CDPClient: {
    connect: mock(() =>
      Promise.resolve({
        send: mockCdpSend,
        waitForEvent: mockCdpWaitForEvent,
        close: mockCdpClose,
        on: mockCdpOn,
        off: mockCdpOff,
        onClose: mockCdpOnClose,
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
    ephemeral: false,
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

// Named sessions persist to disk (see `session-store.ts`). Point that at a private
// temp dir so these tests neither read a developer's real records nor leave any —
// the env pin in `scripts/test/env.ts` covers `YAAR_STORAGE`, but each test here
// wants its *own* store, not a shared one.
const STATE_DIR = await mkdtemp(join(tmpdir(), 'yaar-browser-test-'));
process.env.YAAR_BROWSER_STATE_DIR = STATE_DIR;

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

/** Let the store's load-then-remember chain settle before asserting on a revive. */
const settleStore = () => new Promise((r) => setTimeout(r, 20));

// ── Tests ────────────────────────────────────────────────────────────────────

describe('BrowserPool', () => {
  let pool: InstanceType<typeof BrowserPool>;

  beforeEach(async () => {
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
    // Shutdown deliberately *keeps* session records (that is what makes them
    // survive a restart), so each test starts from an empty file rather than the
    // previous test's tabs.
    await rm(join(STATE_DIR, 'sessions.json'), { force: true });
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

  it('syncExistingTabs is a no-op and never launches Chrome when none is running', async () => {
    const freshPool = new BrowserPool();
    await freshPool.syncExistingTabs();
    expect(mockLaunchChrome).not.toHaveBeenCalled();
    expect(freshPool.getAllSessions().size).toBe(0);
    await freshPool.shutdown();
  });

  it('syncExistingTabs adopts new page targets, skipping known + internal ones', async () => {
    const freshPool = new BrowserPool();
    await freshPool.createSession(); // boots Chrome; knownTargetIds = {'tab-mock'}

    // /json now reports three targets; /json/version keeps its single-object shape.
    mockFetch.mockImplementation((input: unknown) =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            String(input).endsWith('/json')
              ? [
                  // already known (created by YAAR) → skipped
                  {
                    id: 'tab-mock',
                    type: 'page',
                    url: 'about:blank',
                    webSocketDebuggerUrl: 'ws://k',
                  },
                  // pre-existing user tab → adopted
                  {
                    id: 'existing-1',
                    type: 'page',
                    url: 'http://localhost:8000/',
                    title: 'YAAR',
                    webSocketDebuggerUrl: 'ws://e',
                  },
                  // internal devtools page → skipped
                  {
                    id: 'dt-1',
                    type: 'page',
                    url: 'devtools://devtools/x',
                    webSocketDebuggerUrl: 'ws://d',
                  },
                  // not a page → skipped
                  {
                    id: 'sw-1',
                    type: 'service_worker',
                    url: 'http://x/sw.js',
                    webSocketDebuggerUrl: 'ws://s',
                  },
                ]
              : {
                  id: 'tab-mock',
                  webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
                },
          ),
      }),
    );

    await freshPool.syncExistingTabs();

    const urls = [...freshPool.getAllSessions().values()].map(
      (s) => (s as unknown as { currentUrl: string }).currentUrl,
    );
    expect(urls).toContain('http://localhost:8000/');
    expect(urls).not.toContain('devtools://devtools/x');
    // Only the original created tab + the one adopted page target.
    expect(freshPool.getAllSessions().size).toBe(2);

    await freshPool.shutdown();
    // Restore the shared default fetch mock for the remaining tests.
    mockFetch.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            id: 'tab-mock',
            webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/mock',
          }),
      }),
    );
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

  // ── Named sessions and lifecycle (P1) ──────────────────────────────────────

  it('refuses a browserId that is not addressable', async () => {
    for (const bad of ['has space', 'a/b', '-leading', '', 'x'.repeat(65)]) {
      const err = await pool.createSession(bad).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/Invalid browserId/);
    }
    expect(pool.getStats().activeSessions).toBe(0);
  });

  it('keeps the auto-counter clear of an explicitly numeric id', async () => {
    await pool.createSession('7');
    const auto = await pool.createSession();
    // Without the bump the counter would still be at 0 and collide with "7" later.
    expect(auto.browserId).toBe('8');
  });

  it('idle cleanup spares a session someone is watching', async () => {
    const { session } = await pool.createSession();
    await session.startScreencast();
    session.lastActivity = Date.now() - 60 * 60 * 1000;

    await internals(pool).cleanupIdle();

    // Reading a long page is not idleness — a viewer is attached, so it stays.
    expect(pool.getSession('0')).toBe(session);
  });

  it('revives an idle-swept session under the same id, back on its page', async () => {
    const { session } = await pool.createSession('inbox');
    session.currentUrl = 'https://example.com/mail';
    session.currentTitle = 'Mail';
    // What a real navigation ends with, and what writes the record.
    session.emit('updated', { url: session.currentUrl, title: 'Mail', version: 1 });
    await settleStore();

    // The idle sweep drops the socket but keeps the record, which is what makes
    // the id still mean something afterwards.
    session.lastActivity = Date.now() - 60 * 60 * 1000;
    await internals(pool).cleanupIdle();
    expect(pool.getSession('inbox')).toBeUndefined();

    const revived = await pool.reviveSession('inbox');
    expect(revived).not.toBeNull();
    expect(revived!.id).toBe('inbox');
    expect(pool.getSession('inbox')).toBe(revived!);
  });

  it('does not revive a session that was deliberately closed', async () => {
    await pool.createSession('scratch');
    await settleStore();
    await pool.closeSession('scratch');
    await settleStore();

    expect(await pool.reviveSession('scratch')).toBeNull();
  });

  it('reattaches a crashed session in place, keeping its listeners', async () => {
    const { session } = await pool.createSession('news');
    session.currentUrl = 'https://example.com/news';

    const revived = new Promise<void>((resolve) => session.once('revived', () => resolve()));

    // What `Inspector.targetCrashed` / an unexpected socket close produce.
    session.emit('crashed', { reason: 'test' });
    await revived;

    // Same object, same id, still in the map — a viewer subscribed to it never
    // had to know anything happened.
    expect(pool.getSession('news')).toBe(session);
    expect(session.isCrashed).toBe(false);
  });

  it('lists live and suspended sessions for Process Explorer', async () => {
    const { session } = await pool.createSession('one');
    session.currentUrl = 'https://example.com/one';
    session.emit('updated', { url: session.currentUrl, title: '', version: 1 });
    await pool.createSession('two');
    await settleStore();

    session.lastActivity = Date.now() - 60 * 60 * 1000;
    await internals(pool).cleanupIdle();

    const info = await pool.listSessionInfo();
    const byId = Object.fromEntries(info.map((i) => [i.id, i]));
    expect(byId.one.state).toBe('suspended');
    expect(byId.one.url).toBe('https://example.com/one');
    expect(byId.two.state).toBe('live');
  });
});

// The temp state dir must not outlive the run.
process.on('exit', () => {
  void rm(STATE_DIR, { recursive: true, force: true });
});
