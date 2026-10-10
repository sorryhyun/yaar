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
const {
  send: mockCdpSend,
  close: mockCdpClose,
  on: mockCdpOn,
  onClose: mockCdpOnClose,
} = installFakeCdpClient();

// ── Mock chrome process management ───────────────────────────────────────────

const mockFindChrome = mock(() => Promise.resolve('/usr/bin/chrome'));
const mockKill = mock(() => {});
const defaultLaunch = () =>
  Promise.resolve({
    port: 9222,
    // Never exits on its own; the tests that kill Chrome launch their own fake.
    process: { pid: 99999, kill: mockKill, exited: new Promise<number>(() => {}) },
    wsUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
    userDataDir: '/tmp/yaar-browser-mock',
    ephemeral: false,
  });
const mockLaunchChrome = mock(defaultLaunch);
const defaultCleanup = () => Promise.resolve(undefined);
const mockCleanupChrome = mock(defaultCleanup);
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
const defaultFetch = () =>
  Promise.resolve({
    ok: true,
    json: () =>
      Promise.resolve({
        id: 'tab-mock',
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/mock',
      }),
  });
const mockFetch = mock(defaultFetch) as any;
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

  describe('one tab per id while it is coming up', () => {
    const OLD_URL = 'https://example.com/last-time';
    const NEW_URL = 'https://example.com/the-link';
    const navigatedTo = () =>
      (mockCdpSend.mock.calls as unknown as [string, { url?: string }?][])
        .filter(([method]) => method === 'Page.navigate')
        .map(([, params]) => params?.url);
    const tabsOpened = () => fetchedUrls().filter((u) => u.includes('/json/new')).length;

    /** A session for `id` that was on OLD_URL, then idle-swept: a record, no socket. */
    async function sweptSession(id: string) {
      const { session } = await pool.createSession(id);
      session.currentUrl = OLD_URL;
      session.emit('updated', { url: OLD_URL, title: 'Old', version: 1 });
      await settleStore();
      session.lastActivity = Date.now() - 60 * 60 * 1000;
      await internals(pool).cleanupIdle();
      expect(pool.getSession(id)).toBeUndefined();
      mockCdpSend.mockClear();
      mockFetch.mockClear();
    }

    it('open during a revive keeps the revive from replaying the old page', async () => {
      await sweptSession('0');

      // The Browser window's live view revives the id the moment it mounts, and the
      // `?url=` launch opens it right behind.
      const revive = pool.reviveSession('0');
      const opened = await pool.openSession('0');
      await opened.session.navigate(NEW_URL);
      const revived = await revive;

      expect(revived).toBe(opened.session);
      expect(opened.created).toBe(false);
      expect(tabsOpened()).toBe(1);
      expect(navigatedTo()).toEqual([NEW_URL]);
    });

    it('a revive during an open joins its tab instead of opening another', async () => {
      await sweptSession('0');

      const opening = pool.openSession('0');
      const revived = await pool.reviveSession('0');
      const opened = await opening;

      expect(opened.created).toBe(true);
      expect(revived).toBe(opened.session);
      expect(tabsOpened()).toBe(1);
      expect(navigatedTo()).not.toContain(OLD_URL);
    });

    it('two concurrent creations of one id share a tab', async () => {
      const [a, b] = await Promise.all([pool.createSession('x'), pool.createSession('x')]);
      expect(a.session).toBe(b.session);
      expect(pool.getSession('x')).toBe(a.session);
      expect(tabsOpened()).toBe(1);
    });

    it('a revive with nobody opening still replays the recorded page', async () => {
      await sweptSession('inbox');
      await pool.reviveSession('inbox');
      expect(navigatedTo()).toEqual([OLD_URL]);
    });
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

  it('does not report a revived session closed when its crashed target dies', async () => {
    mockCdpOn.mockClear();
    let n = 0;
    mockFetch.mockImplementation((input: unknown) =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            String(input).includes('/json/new')
              ? { id: `tab-${n++}`, webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/x' }
              : { webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc' },
          ),
      }),
    );
    try {
      const { session } = await pool.createSession('news'); // target tab-0
      const revived = new Promise<void>((resolve) => session.once('revived', () => resolve()));
      session.emit('crashed', { reason: 'test' });
      await revived;
      await settleStore(); // `revived` fires inside reattach; the rebind to tab-1 follows it

      const destroyed = (mockCdpOn.mock.calls as unknown as [string, (p: unknown) => void][])
        .filter(([name]) => name === 'Target.targetDestroyed')
        .at(-1)![1];
      const events: string[] = [];
      pool.onTabEvent((e) => events.push(`${e.type}:${e.browserId}`));

      // The tab the crash left behind is nobody's any more.
      destroyed({ targetId: 'tab-0' });
      expect(events).toEqual([]);
      expect(pool.getSession('news')).toBe(session);

      // The tab actually serving the session still is.
      destroyed({ targetId: 'tab-1' });
      expect(events).toEqual(['closed:news']);
    } finally {
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
    }
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

// ── Chrome itself dying (bugs.md #1) ─────────────────────────────────────────

/** A launched Chrome whose process exit the test decides. */
function fakeChrome(port: number) {
  let die!: (code: number) => void;
  const exited = new Promise<number>((resolve) => (die = resolve));
  return {
    die,
    instance: {
      port,
      process: { pid: 90_000 + port, kill: mockKill, exited },
      wsUrl: `ws://127.0.0.1:${port}/devtools/browser/abc`,
      userDataDir: '/tmp/yaar-browser-mock',
      ephemeral: false,
    },
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out: ${what}`)), ms)),
  ]);
}

/** The socket-close handler the most recently attached tab registered. */
function lastSocketClose(): (expected: boolean) => void {
  return (mockCdpOnClose.mock.calls as unknown as [(expected: boolean) => void][]).at(-1)![0];
}

/** Chrome at `deadPort` has stopped answering; everything else behaves as by default. */
function portIsDead(deadPort: number) {
  mockFetch.mockImplementation((input: unknown) =>
    String(input).includes(`:${deadPort}/`)
      ? Promise.reject(new Error('ECONNREFUSED'))
      : defaultFetch(),
  );
}

const fetchedUrls = () => (mockFetch.mock.calls as unknown as [unknown][]).map(([u]) => String(u));

describe('HeadlessServerBrowser when its Chrome dies', () => {
  let pool: InstanceType<typeof HeadlessServerBrowser>;

  beforeEach(async () => {
    // Reset, not clear: a launch queued with `mockImplementationOnce` that a test never
    // consumed must not become the next test's Chrome.
    mockLaunchChrome.mockReset();
    mockLaunchChrome.mockImplementation(defaultLaunch);
    mockCleanupChrome.mockReset();
    mockCleanupChrome.mockImplementation(defaultCleanup);
    mockFetch.mockClear();
    mockFetch.mockImplementation(defaultFetch);
    mockCdpSend.mockImplementation(() => Promise.resolve({}));
    await rm(join(STATE_DIR, 'sessions.json'), { force: true });
    pool = new HeadlessServerBrowser();
  });

  afterEach(async () => {
    await pool.shutdown();
    mockFetch.mockImplementation(defaultFetch);
  });

  it('relaunches Chrome and brings its sessions back when the process exits', async () => {
    const first = fakeChrome(9222);
    const second = fakeChrome(9333);
    mockLaunchChrome
      .mockImplementationOnce(() => Promise.resolve(first.instance))
      .mockImplementationOnce(() => Promise.resolve(second.instance));

    const { session } = await pool.createSession('news');
    const revived = new Promise<void>((resolve) => session.once('revived', () => resolve()));

    first.die(137); // OOM kill, GPU crash, a user's `kill`
    await withTimeout(revived, 2000, 'the session was never revived');

    expect(mockLaunchChrome).toHaveBeenCalledTimes(2);
    expect(pool.getSession('news')).toBe(session);
    expect(session.isCrashed).toBe(false);
    // The fresh tab was opened on the new Chrome, not the dead one.
    expect(fetchedUrls()).toContain('http://127.0.0.1:9333/json/new?about:blank');
    expect(pool.getStats().chromeRunning).toBe(true);
  });

  it('relaunches when a tab reports the crash before the process exit is seen', async () => {
    const first = fakeChrome(9222);
    const second = fakeChrome(9333);
    mockLaunchChrome
      .mockImplementationOnce(() => Promise.resolve(first.instance))
      .mockImplementationOnce(() => Promise.resolve(second.instance));

    const { session } = await pool.createSession('news');
    const revived = new Promise<void>((resolve) => session.once('revived', () => resolve()));

    // Chrome is gone, but only the tab's socket has said so yet.
    portIsDead(9222);
    lastSocketClose()(false);
    await withTimeout(revived, 2000, 'the session was never revived');

    expect(mockLaunchChrome).toHaveBeenCalledTimes(2);
    expect(session.isCrashed).toBe(false);
    expect(fetchedUrls()).toContain('http://127.0.0.1:9333/json/new?about:blank');
  });

  it('revive actually revives a crashed session', async () => {
    const first = fakeChrome(9222);
    const second = fakeChrome(9333);
    mockLaunchChrome
      .mockImplementationOnce(() => Promise.resolve(first.instance))
      // The automatic relaunch fails, leaving the session crashed…
      .mockImplementationOnce(() => Promise.reject(new Error('Chrome launch timeout (10s)')))
      // …and the explicit revive gets a working Chrome.
      .mockImplementationOnce(() => Promise.resolve(second.instance));

    const { session } = await pool.createSession('news');
    portIsDead(9222);
    lastSocketClose()(false);
    await settleStore();
    expect(session.isCrashed).toBe(true);

    const revived = await pool.reviveSession('news');
    expect(revived).toBe(session);
    expect(session.isCrashed).toBe(false);
    expect(fetchedUrls()).toContain('http://127.0.0.1:9333/json/new?about:blank');
  });

  it('does not read its own release of Chrome as a crash', async () => {
    const first = fakeChrome(9222);
    mockLaunchChrome.mockImplementationOnce(() => Promise.resolve(first.instance));
    // The kill inside cleanup is what makes the process exit.
    mockCleanupChrome.mockImplementationOnce(async () => {
      first.die(0);
      await settleStore();
    });

    await pool.createSession('pinned-elsewhere');
    await pool.closeSession('pinned-elsewhere'); // last session: Chrome is released
    await settleStore();

    expect(mockLaunchChrome).toHaveBeenCalledTimes(1);
    expect(pool.getStats().chromeRunning).toBe(false);
  });
});

// ── Pinned internal tabs and the session cap (bugs.md #5) ────────────────────

describe('HeadlessServerBrowser pinned internal tabs', () => {
  let pool: InstanceType<typeof HeadlessServerBrowser>;

  beforeEach(async () => {
    mockLaunchChrome.mockReset();
    mockLaunchChrome.mockImplementation(defaultLaunch);
    mockFetch.mockImplementation(defaultFetch);
    await rm(join(STATE_DIR, 'sessions.json'), { force: true });
    pool = new HeadlessServerBrowser();
  });

  afterEach(async () => {
    await pool.shutdown();
  });

  it('do not take the slots users and apps are told about', async () => {
    // The companion desktop and a remote-ML host channel.
    await pool.createSession('companion-desktop', { pinned: true });
    await pool.createSession('ml-host-abc', { pinned: true });
    for (let i = 0; i < 5; i++) await pool.createSession();

    expect(pool.getStats()).toMatchObject({
      activeSessions: 5,
      internalSessions: 2,
      maxSessions: 5,
    });
    const err = await pool.createSession().catch((e: Error) => e);
    expect((err as Error).message).toMatch(/limit reached/i);

    const info = await pool.listSessionInfo();
    const byId = Object.fromEntries(info.map((i) => [i.id, i]));
    expect(byId['companion-desktop'].pinned).toBe(true);
    expect(byId['0'].pinned).toBe(false);
  });

  it('are still bounded among themselves', async () => {
    for (let i = 0; i < 5; i++) await pool.createSession(`ml-host-${i}`, { pinned: true });
    const err = await pool.createSession('ml-host-5', { pinned: true }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    // A user tab is still free to open.
    await pool.createSession();
    expect(pool.getStats().activeSessions).toBe(1);
  });

  it('come back pinned when revived from their record', async () => {
    const { session } = await pool.createSession('companion-desktop', { pinned: true });
    session.emit('updated', { url: session.currentUrl, title: '', version: 1 });
    await settleStore();
    // Server restart: the record is all that is left.
    await pool.shutdown();
    pool = new HeadlessServerBrowser();

    for (let i = 0; i < 5; i++) await pool.createSession();
    const revived = await pool.reviveSession('companion-desktop');
    expect(revived?.pinned).toBe(true);
  });
});

// ── Viewer count (bugs.md #6) ────────────────────────────────────────────────

describe('HeadlessServerBrowser session info', () => {
  it('reports how many viewers are watching, not just whether one is', async () => {
    mockFetch.mockImplementation(defaultFetch);
    await rm(join(STATE_DIR, 'sessions.json'), { force: true });
    const pool = new HeadlessServerBrowser();
    try {
      const { session } = await pool.createSession('watched');
      await session.startScreencast();
      await session.startScreencast();
      const info = (await pool.listSessionInfo()).find((i) => i.id === 'watched');
      expect(info?.viewers).toBe(2);

      await session.stopScreencast();
      const after = (await pool.listSessionInfo()).find((i) => i.id === 'watched');
      expect(after?.viewers).toBe(1);
    } finally {
      await pool.shutdown();
    }
  });
});

// The temp state dir must not outlive the run.
process.on('exit', () => {
  void rm(STATE_DIR, { recursive: true, force: true });
});
