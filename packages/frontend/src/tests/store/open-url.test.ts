/**
 * `yaar:open-url` — where a link inside an app goes now that it no longer replaces
 * the app's own document.
 *
 * The bridge's link guard cancels the navigation and posts the URL out; the desktop
 * has to actually put it somewhere, or the click becomes a no-op and the guard trades
 * a silent crash for a silent nothing. A window is the destination: the windows SDK
 * is read-only, and `window.open` would leave YAAR for a browser tab.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'bun:test';
import { useDesktopStore } from '@/store';

const MONITOR_ID = '0';
const DESKTOP_URL = 'http://localhost:8000/';

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

describe('opening a link from inside an app', () => {
  beforeAll(() => setPageUrl(DESKTOP_URL));
  afterAll(() => setPageUrl('about:blank'));
  beforeEach(resetStore);

  it('opens the URL in a window and tells the agent about it', () => {
    postFromIframe({
      type: 'yaar:open-url',
      url: 'https://example.com/post/1',
      title: 'Read the post',
    });

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

  it('resolves a root-relative href against the desktop origin', () => {
    postFromIframe({ type: 'yaar:open-url', url: '/board/123' });

    const [win] = openedWindows();
    expect(win.content.data).toBe(`${window.location.origin}/board/123`);
    // No link text: the host is a better window title than the whole URL.
    expect(win.title).toBe(window.location.hostname);
  });

  it('refuses anything that is not http(s)', () => {
    postFromIframe({ type: 'yaar:open-url', url: 'javascript:alert(1)' });
    postFromIframe({ type: 'yaar:open-url', url: 'file:///etc/passwd' });
    postFromIframe({ type: 'yaar:open-url', url: '' });
    postFromIframe({ type: 'yaar:open-url' });

    expect(openedWindows()).toHaveLength(0);
  });
});
