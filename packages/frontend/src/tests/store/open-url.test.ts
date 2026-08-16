/**
 * `yaar:open-url` — where a link inside an app goes now that it no longer replaces
 * the app's own document.
 *
 * The bridge's link guard cancels the navigation and posts the URL out; the desktop
 * has to actually put it somewhere, or the click becomes a no-op and the guard trades
 * a silent crash for a silent nothing. A window is the destination: the windows SDK
 * is read-only, and `window.open` would leave YAAR for a browser tab.
 *
 * *Which* window depends on the site. Framing is the target's call — `frame-ancestors`
 * is enforced by the browser on the target's own document and the embedder cannot
 * override it — so a link to a site that refuses framing became a window that never
 * painted. The desktop now asks first and sends those to the Browser app, which renders
 * server-side and frames nothing. Every step of that has a fallback back to the iframe
 * window, because a clicked link opening *nothing* is the one outcome worth ruling out.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'bun:test';
import { useDesktopStore } from '@/store';

const MONITOR_ID = '0';
const DESKTOP_URL = 'http://localhost:8000/';
const BROWSER_RUN = 'yaar://apps/browser/dist/index.html';

/** happy-dom starts on `about:blank`, where nothing relative can resolve. */
function setPageUrl(href: string) {
  (window as unknown as { happyDOM?: { setURL: (u: string) => void } }).happyDOM?.setURL(href);
}

function resetStore() {
  useDesktopStore.setState({
    windows: {},
    zOrder: [],
    focusedWindowId: null,
    activeMonitorId: MONITOR_ID,
    pendingInteractions: [],
    sessionId: 'session-1',
  });
}

function postFromIframe(data: Record<string, unknown>) {
  // happy-dom's `window.MessageEvent` and the global one are different classes, and
  // `dispatchEvent` only accepts the window's own.
  const Ctor = (window as unknown as { MessageEvent: typeof MessageEvent }).MessageEvent;
  window.dispatchEvent(new Ctor('message', { data }));
}

function openedWindows() {
  return Object.values(useDesktopStore.getState().windows);
}

/** URLs the stubbed server reports as refusing to be framed. */
const refusesFraming = new Set<string>();

const realFetch = globalThis.fetch;

/**
 * Placing a window now costs a round trip (the embeddability probe, and for a refused
 * site the app list and a token mint), so every assertion has to wait for the chain to
 * drain. Several turns, because the paths are up to three awaits deep.
 */
async function settle(turns = 8) {
  for (let i = 0; i < turns; i++) await new Promise((r) => setTimeout(r, 0));
}

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('opening a link from inside an app', () => {
  beforeAll(() => {
    setPageUrl(DESKTOP_URL);
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = String(input instanceof Request ? input.url : input);
      if (path.startsWith('/api/embeddable')) {
        const target = new URLSearchParams(path.split('?')[1] ?? '').get('url') ?? '';
        return jsonOk({ embeddable: !refusesFraming.has(target) });
      }
      if (path.startsWith('/api/apps')) {
        return jsonOk({ apps: [{ id: 'browser', name: 'Browser', run: BROWSER_RUN }] });
      }
      if (path.startsWith('/api/iframe-token')) {
        return jsonOk({ token: 'iframe-token-1' });
      }
      throw new Error(`unexpected fetch: ${path}`);
    }) as typeof fetch;
  });
  afterAll(() => {
    setPageUrl('about:blank');
    globalThis.fetch = realFetch;
  });
  beforeEach(() => {
    resetStore();
    refusesFraming.clear();
  });

  it('opens a framable URL in a window and tells the agent about it', async () => {
    postFromIframe({
      type: 'yaar:open-url',
      url: 'https://example.com/post/1',
      title: 'Read the post',
    });
    await settle();

    const [win] = openedWindows();
    expect(win.title).toBe('Read the post');
    expect(win.content).toEqual({ renderer: 'iframe', data: 'https://example.com/post/1' });

    // A window the agent did not open still has to reach it, or the next thing it
    // reads of the desktop contains a window it cannot account for.
    const [interaction] = useDesktopStore.getState().pendingInteractions;
    expect(interaction).toMatchObject({
      type: 'window.create',
      windowTitle: 'Read the post',
      monitorId: MONITOR_ID,
    });
    // The store keys a window by monitor; the interaction carries the bare id, as
    // every other window.create interaction does.
    expect(win.id).toBe(`${MONITOR_ID}/${interaction.windowId}`);
  });

  it('resolves a root-relative href against the desktop origin', async () => {
    postFromIframe({ type: 'yaar:open-url', url: '/board/123' });
    await settle();

    const [win] = openedWindows();
    expect(win.content.data).toBe(`${window.location.origin}/board/123`);
    // No link text: the host is a better window title than the whole URL.
    expect(win.title).toBe(window.location.hostname);
  });

  it('refuses anything that is not http(s)', async () => {
    postFromIframe({ type: 'yaar:open-url', url: 'javascript:alert(1)' });
    postFromIframe({ type: 'yaar:open-url', url: 'file:///etc/passwd' });
    postFromIframe({ type: 'yaar:open-url', url: '' });
    postFromIframe({ type: 'yaar:open-url' });
    await settle();

    expect(openedWindows()).toHaveLength(0);
  });

  it('sends a site that refuses framing to the Browser app instead', async () => {
    refusesFraming.add('https://x.com/some/post');
    postFromIframe({ type: 'yaar:open-url', url: 'https://x.com/some/post', title: 'A post' });
    await settle();

    const [win] = openedWindows();
    // An app window, keyed by app id, carrying the link as the Browser app's launch
    // parameter — and a token, without which the app cannot make a single verb call.
    expect(win.id).toBe(`${MONITOR_ID}/browser`);
    expect(win.appId).toBe('browser');
    expect(win.iframeToken).toBe('iframe-token-1');
    expect(win.content.data).toBe(
      `${BROWSER_RUN}?url=${encodeURIComponent('https://x.com/some/post')}`,
    );

    const [interaction] = useDesktopStore.getState().pendingInteractions;
    expect(interaction).toMatchObject({ type: 'window.create', windowId: 'browser' });
  });

  it('falls back to an iframe window when the probe itself fails', async () => {
    const stub = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    try {
      postFromIframe({ type: 'yaar:open-url', url: 'https://example.com/still-opens' });
      await settle();
    } finally {
      globalThis.fetch = stub;
    }

    // Not knowing is not a reason to withhold the window — and framing everything is
    // exactly what the desktop did before the probe existed.
    const [win] = openedWindows();
    expect(win.content).toEqual({ renderer: 'iframe', data: 'https://example.com/still-opens' });
  });
});
