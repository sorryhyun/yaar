/**
 * Tests for LocalUserBrowser — the BrowserProvider that attaches to the user's
 * own Chrome instead of launching a private headless one.
 *
 * Mocks cdp.js (WebSocket) and global fetch (Chrome debug HTTP API). There is no
 * chrome.js mock because LocalUserBrowser never spawns a process — that absence
 * is precisely the behavior under test.
 */
import { mock, describe, it, expect, beforeEach, afterEach } from 'bun:test';

// ── Mock CDP client ──────────────────────────────────────────────────────────

const mockCdpSend = mock(() => Promise.resolve({}));
const mockCdpClose = mock(() => {});
const mockCdpOn = mock(() => {});

mock.module('../lib/browser/cdp.js', () => ({
  CDPClient: {
    connect: mock(() =>
      Promise.resolve({
        send: mockCdpSend,
        waitForEvent: mock(() => Promise.resolve(undefined)),
        close: mockCdpClose,
        on: mockCdpOn,
      }),
    ),
  },
}));

// ── Mock global fetch for Chrome debug HTTP API ──────────────────────────────

let fetchOk = true;
 
const mockFetch = mock(() =>
  Promise.resolve({
    ok: fetchOk,
    json: () =>
      Promise.resolve({
        id: 'tab-mock',
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/mock',
      }),
  }),
) as any;
globalThis.fetch = mockFetch;

const { LocalUserBrowser } = await import('../lib/browser/local-user-browser.js');

describe('LocalUserBrowser', () => {
  let browser: InstanceType<typeof LocalUserBrowser>;

  beforeEach(() => {
    fetchOk = true;
    mockFetch.mockClear();
    mockCdpClose.mockClear();
    browser = new LocalUserBrowser(9222);
  });

  afterEach(async () => {
    await browser.shutdown();
  });

  it('attaches to the user Chrome without launching one', async () => {
    const { session, browserId } = await browser.createSession();

    expect(browserId).toBe('0');
    expect(session).toBeDefined();
    expect(browser.getSession('0')).toBe(session);

    const stats = browser.getStats();
    expect(stats.activeSessions).toBe(1);
    expect(stats.chromeRunning).toBe(true);
  });

  it('does NOT kill the user Chrome when the last session closes', async () => {
    await browser.createSession();
    await browser.closeSession('0');

    expect(browser.getSession('0')).toBeUndefined();
    expect(browser.getStats().activeSessions).toBe(0);
    // The user's browser stays connected — we never own or release it on close.
    expect(browser.getStats().chromeRunning).toBe(true);
  });

  it('isAvailable reflects whether the debug endpoint is reachable', async () => {
    fetchOk = true;
    expect(await browser.isAvailable()).toBe(true);

    fetchOk = false;
    expect(await browser.isAvailable()).toBe(false);
  });

  it('createSession throws a helpful error when Chrome is unreachable', async () => {
    fetchOk = false;
    const err = await browser.createSession().catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/--remote-debugging-port/);
  });

  it('shutdown disconnects from the user Chrome', async () => {
    await browser.createSession();
    await browser.shutdown();

    expect(browser.getStats().activeSessions).toBe(0);
    expect(browser.getStats().chromeRunning).toBe(false);
  });
});
