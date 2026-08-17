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
 *
 * Before any of that the desktop asks the user's own rules — a `link_open` hook naming a
 * site and an app (`GET /api/hooks/link`). The cases below pin what that does *not* do as
 * much as what it does: no rule means no routing however capable the installed app is, an
 * app that answers "not mine" hands the link straight back, and a window opened for a link
 * the app then declines is closed again rather than left behind.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'bun:test';
import { useDesktopStore } from '@/store';
import { toWindowKey } from '@/store/helpers';

const MONITOR_ID = '0';
const DESKTOP_URL = 'http://localhost:8000/';
const BROWSER_RUN = 'yaar://apps/browser/dist/index.html';
const GITHUB_RUN = 'yaar://apps/github/dist/index.html';

/**
 * The user's `link_open` rules, as `GET /api/hooks/link` answers them — the only thing
 * that makes a link reach an app rather than a window of its own. Keyed by URL prefix,
 * the way the hook's `url` filter matches.
 */
const linkRules = new Map<string, { appId: string; command: string; launch?: boolean }>();

function ruleFor(url: string) {
  for (const [prefix, handler] of linkRules) if (url.startsWith(prefix)) return handler;
  return null;
}

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

function postFromIframe(data: Record<string, unknown>, source?: unknown) {
  // happy-dom's `window.MessageEvent` and the global one are different classes, and
  // `dispatchEvent` only accepts the window's own.
  const Ctor = (window as unknown as { MessageEvent: typeof MessageEvent }).MessageEvent;
  const event = new Ctor('message', { data });
  // happy-dom's MessageEvent constructor doesn't accept `source` in the init dict.
  if (source) Object.defineProperty(event, 'source', { value: source, writable: false });
  window.dispatchEvent(event);
}

/** Commands the desktop sent to an app window this test opened. */
interface LocalCommand {
  command: string;
  params: Record<string, unknown>;
}

/**
 * An app's iframe, mounted and registered, answering `openUrl` with `reply`.
 *
 * The DOM half only — the store window is the desktop's to create when it launches the
 * app itself. `yaar:app-ready` is announced the way a real app announces it, because
 * that handshake is what the desktop waits for before sending a command to a window it
 * just opened.
 */
function armApp(appId: string, reply: unknown) {
  const key = toWindowKey(MONITOR_ID, appId);
  const received: LocalCommand[] = [];

  const container = document.createElement('div');
  container.setAttribute('data-window-id', key);
  const iframe = document.createElement('iframe');
  container.appendChild(iframe);
  document.body.appendChild(container);

  const contentWindow = {
    postMessage(msg: Record<string, unknown>) {
      if (msg.type !== 'yaar:app-command-request') return;
      received.push({
        command: msg.command as string,
        params: msg.params as Record<string, unknown>,
      });
      postFromIframe(
        { type: 'yaar:app-command-response', requestId: msg.requestId, result: reply },
        contentWindow,
      );
    },
  };
  Object.defineProperty(iframe, 'contentWindow', { value: contentWindow, writable: false });
  postFromIframe({ type: 'yaar:app-ready' }, contentWindow);

  return { key, received, contentWindow, cleanup: () => container.remove() };
}

/** `armApp`, plus the store window an already-open app would have. */
function openAppWindow(appId: string, reply: unknown) {
  const app = armApp(appId, reply);
  useDesktopStore.setState((s) => ({
    windows: {
      ...s.windows,
      [app.key]: {
        id: app.key,
        title: appId,
        appId,
        monitorId: MONITOR_ID,
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        content: { renderer: 'iframe', data: 'about:blank' },
      } as never,
    },
  }));
  return app;
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
      if (path.startsWith('/api/hooks/link')) {
        const target = new URLSearchParams(path.split('?')[1] ?? '').get('url') ?? '';
        return jsonOk({ handler: ruleFor(target) });
      }
      if (path.startsWith('/api/apps')) {
        return jsonOk({
          apps: [
            { id: 'browser', name: 'Browser', run: BROWSER_RUN },
            { id: 'github', name: 'GitHub', run: GITHUB_RUN },
          ],
        });
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
    linkRules.clear();
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

  it('hands a link to the app the user wired the site to', async () => {
    linkRules.set('https://github.com/', { appId: 'github', command: 'openUrl' });
    const app = openAppWindow('github', { handled: true });
    refusesFraming.add('https://github.com/anthropics/claude-code');
    try {
      postFromIframe({
        type: 'yaar:open-url',
        url: 'https://github.com/anthropics/claude-code',
        title: 'claude-code',
      });
      await settle();

      expect(app.received).toEqual([
        { command: 'openUrl', params: { url: 'https://github.com/anthropics/claude-code' } },
      ]);
      // The app took it: no second window, and least of all a Browser app one.
      expect(openedWindows()).toHaveLength(1);
      expect(useDesktopStore.getState().focusedWindowId).toBe(app.key);
    } finally {
      app.cleanup();
    }
  });

  it('places the link itself when the wired app has no view for it', async () => {
    linkRules.set('https://github.com/', { appId: 'github', command: 'openUrl' });
    const app = openAppWindow('github', { handled: false });
    refusesFraming.add('https://github.com/settings/tokens');
    try {
      postFromIframe({ type: 'yaar:open-url', url: 'https://github.com/settings/tokens' });
      await settle();

      expect(app.received).toHaveLength(1);
      // "Not mine" is the whole reason the desktop asks — the link still has to land.
      const browser = openedWindows().find((w) => w.appId === 'browser');
      expect(browser?.content.data).toBe(
        `${BROWSER_RUN}?url=${encodeURIComponent('https://github.com/settings/tokens')}`,
      );
    } finally {
      app.cleanup();
    }
  });

  it('never hands a link back to the window it came from', async () => {
    linkRules.set('https://github.com/', { appId: 'github', command: 'openUrl' });
    const app = openAppWindow('github', { handled: true });
    refusesFraming.add('https://github.com/anthropics/claude-code/issues/1');
    try {
      // The app's own "Open on GitHub ↗" link: it saw this URL through its `links.onOpen`
      // hook and let it go, so bouncing it back would make the link unclickable.
      postFromIframe(
        { type: 'yaar:open-url', url: 'https://github.com/anthropics/claude-code/issues/1' },
        app.contentWindow,
      );
      await settle();

      expect(app.received).toEqual([]);
      expect(openedWindows().some((w) => w.appId === 'browser')).toBe(true);
    } finally {
      app.cleanup();
    }
  });

  it('opens the wired app when it is closed, then hands it the link', async () => {
    linkRules.set('https://github.com/', { appId: 'github', command: 'openUrl' });
    refusesFraming.add('https://github.com/anthropics/claude-code');
    // Answers the command once its window exists — which is what the desktop is waiting
    // for when it opens the app itself.
    const app = armApp('github', { handled: true });
    try {
      postFromIframe({ type: 'yaar:open-url', url: 'https://github.com/anthropics/claude-code' });
      await settle(20);

      expect(app.received).toEqual([
        { command: 'openUrl', params: { url: 'https://github.com/anthropics/claude-code' } },
      ]);
      const [win] = openedWindows();
      expect(win.appId).toBe('github');
      expect(win.content.data).toBe(GITHUB_RUN);
      expect(win.iframeToken).toBe('iframe-token-1');
      // Reported to the agent only once the app took it — see `openInHookedApp`.
      const [interaction] = useDesktopStore.getState().pendingInteractions;
      expect(interaction).toMatchObject({ type: 'window.create', windowId: 'github' });
    } finally {
      app.cleanup();
    }
  });

  it('closes an app it opened when that app turns the link down', async () => {
    linkRules.set('https://github.com/', { appId: 'github', command: 'openUrl' });
    refusesFraming.add('https://github.com/settings/tokens');
    const app = armApp('github', { handled: false });
    try {
      postFromIframe({ type: 'yaar:open-url', url: 'https://github.com/settings/tokens' });
      await settle(20);

      expect(app.received).toHaveLength(1);
      // The window opened for the link is gone, and the link is where it can be shown.
      const ids = openedWindows().map((w) => w.appId);
      expect(ids).not.toContain('github');
      expect(ids).toContain('browser');
      // Nothing about the discarded window reaches the agent.
      expect(
        useDesktopStore.getState().pendingInteractions.filter((i) => i.windowId === 'github'),
      ).toHaveLength(0);
    } finally {
      app.cleanup();
    }
  });

  it('leaves a launch-opted-out rule alone when its app is closed', async () => {
    linkRules.set('https://github.com/', { appId: 'github', command: 'openUrl', launch: false });
    refusesFraming.add('https://github.com/anthropics/claude-code');
    const app = armApp('github', { handled: true });
    try {
      postFromIframe({ type: 'yaar:open-url', url: 'https://github.com/anthropics/claude-code' });
      await settle(20);

      expect(app.received).toEqual([]);
      expect(openedWindows().map((w) => w.appId)).toEqual(['browser']);
    } finally {
      app.cleanup();
    }
  });

  it('places the link as usual when the user has wired no rule for the site', async () => {
    const app = openAppWindow('github', { handled: true });
    refusesFraming.add('https://github.com/anthropics/claude-code');
    try {
      postFromIframe({ type: 'yaar:open-url', url: 'https://github.com/anthropics/claude-code' });
      await settle();

      // An installed app that *can* show a site is not asked until its user says so:
      // routing is a `link_open` hook in config/hooks.json, not a claim in app.json.
      expect(app.received).toEqual([]);
      expect(openedWindows().some((w) => w.appId === 'browser')).toBe(true);
    } finally {
      app.cleanup();
    }
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
