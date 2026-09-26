/**
 * Tests for HeadlessServerBrowser — Chrome process and tab session management.
 *
 * Mocks chrome.js (process management), cdp.js (WebSocket connections),
 * and global fetch (Chrome debug HTTP API) to test pool logic in isolation.
 * BrowserSession uses the mocked CDPClient, so no separate session mock is needed.
 */
import { mock, describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { installFakeCdpClient } from './helpers/mock-cdp-client.js';

// ── Mock CDP client ──────────────────────────────────────────────────────────

// `waitForEvent` and `onClose` (crash-watch arm) aren't asserted on by this file —
// the helper still wires them into the mock's shape, just not into a binding here.
const { send: mockCdpSend, close: mockCdpClose, on: mockCdpOn } = installFakeCdpClient();

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
const { HeadlessServerBrowser } = await import('../lib/browser/pool.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

function internals(pool: InstanceType<typeof HeadlessServerBrowser>) {
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

describe('HeadlessServerBrowser', () => {
  let pool: InstanceType<typeof HeadlessServerBrowser>;

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
    pool = new HeadlessServerBrowser();
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

  it('enforces max sessions limit (5) under concurrent creation', async () => {
    // 8 fired at once (not one at a time, unlike the sequential test above) to
    // actually exercise concurrent access to the size+pendingSessions guard in
    // `CdpBrowserProvider.createSession` (cdp-provider.ts).
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => pool.createSession()));

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBeLessThanOrEqual(5);
    for (const r of rejected as PromiseRejectedResult[]) {
      expect(r.reason).toBeInstanceOf(Error);
      expect((r.reason as Error).message).toMatch(/limit reached/i);
    }
    expect(pool.getStats().activeSessions).toBeLessThanOrEqual(5);
    expect(pool.getStats().activeSessions).toBe(fulfilled.length);
  });

  // One layer down: on a cold pool, getChrome() awaits findChrome() before anything is
  // launched. It used to claim initPromise only after that await, so every caller that
  // arrived during the lookup launched its own Chrome and all but the last were orphaned
  // (8 concurrent calls -> 5 launches). The claim now happens before the first await.
  it('launches Chrome only once for concurrent createSession calls on a cold pool', async () => {
    await Promise.allSettled(Array.from({ length: 8 }, () => pool.createSession()));
    expect(mockLaunchChrome).toHaveBeenCalledTimes(1);
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
    const freshPool = new HeadlessServerBrowser();
    await freshPool.syncExistingTabs();
    expect(mockLaunchChrome).not.toHaveBeenCalled();
    expect(freshPool.getAllSessions().size).toBe(0);
    await freshPool.shutdown();
  });

  it('syncExistingTabs adopts new page targets, skipping known + internal ones', async () => {
    const freshPool = new HeadlessServerBrowser();
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
    const freshPool = new HeadlessServerBrowser();
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

  it('follows navigations the tab makes on its own (a human in the live view)', async () => {
    mockCdpOn.mockClear();
    const { session } = await pool.createSession('live');
    const handler = (event: string) =>
      (mockCdpOn.mock.calls as unknown as [string, (p: unknown) => void][])
        .filter(([name]) => name === event)
        .at(-1)![1];
    const updates: string[] = [];
    session.on('updated', (u: { url: string }) => updates.push(u.url));

    // A sub-frame moving is not the tab moving.
    handler('Page.frameNavigated')({
      frame: { id: 'sub', parentId: 'main', url: 'https://ads.example/x' },
    });
    expect(session.currentUrl).not.toBe('https://ads.example/x');

    handler('Page.frameNavigated')({
      frame: { id: 'main', url: 'https://arxiv.org/pdf/2609.20511' },
    });
    expect(session.currentUrl).toBe('https://arxiv.org/pdf/2609.20511');

    handler('Page.navigatedWithinDocument')({
      frameId: 'main',
      url: 'https://arxiv.org/pdf/2609.20511#page=3',
    });
    expect(session.currentUrl).toBe('https://arxiv.org/pdf/2609.20511#page=3');

    // An unchanged address is not news.
    handler('Page.frameNavigated')({
      frame: { id: 'main', url: 'https://arxiv.org/pdf/2609.20511', urlFragment: '#page=3' },
    });
    expect(updates).toEqual([
      'https://arxiv.org/pdf/2609.20511',
      'https://arxiv.org/pdf/2609.20511#page=3',
    ]);
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
