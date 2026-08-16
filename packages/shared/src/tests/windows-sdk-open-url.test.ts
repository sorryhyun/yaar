/**
 * `yaar.windows.openUrl` — the way an app hands a URL somewhere without leaving.
 *
 * Before it, an app's only outs were `window.open` (a browser tab, outside YAAR)
 * and a plain link (which navigates the app's own frame and takes the app protocol
 * with it). The windows SDK is otherwise read-only; this is the one write, and it
 * is fire-and-forget because the desktop owns window creation.
 *
 * The second suite covers the `window.open` override, which puts an app's popups
 * on this same path. It is what makes an app written against the open web — or one
 * that predates `openUrl` — open its links in a YAAR window without an edit, and
 * what removes the "popup blocked, address copied instead" branch those apps carry.
 */
import { describe, it, expect } from 'bun:test';
import { IFRAME_WINDOWS_SDK_SCRIPT } from '../iframe-scripts/windows-sdk.js';

interface Posted {
  type: string;
  url?: string;
  title?: string;
}

interface OpenCall {
  url: unknown;
  target: unknown;
}

/** Return of the shimmed `window.open` — the stub, or whatever native returned. */
type Opened = { closed?: boolean; location?: { href: string } } | string | null;

/**
 * Run the script against a fake `window`. `document` is a function parameter, not
 * the ambient global, so a test decides whether the frame has a base URI at all
 * (the shared partition runs without a DOM).
 */
function install(opts: { baseURI?: string; nativeOpen?: boolean } = {}) {
  const posted: Posted[] = [];
  const opens: OpenCall[] = [];
  const window = {
    __yaarWindowsInstalled: false,
    parent: { postMessage: (msg: Posted) => posted.push(msg) },
    ...(opts.nativeOpen
      ? {
          open: (url: unknown, target: unknown) => {
            opens.push({ url, target });
            return 'native-window';
          },
        }
      : {}),
  } as Record<string, unknown>;
  const document = opts.baseURI ? { baseURI: opts.baseURI } : undefined;

  new Function('window', 'document', IFRAME_WINDOWS_SDK_SCRIPT)(window, document);
  const windows = (window.yaar as { windows: { openUrl: (u: unknown, o?: unknown) => void } })
    .windows;
  const open = window.open as (url?: unknown, target?: unknown) => Opened;
  return { windows, posted, open, opens, window };
}

describe('windows.openUrl', () => {
  it('posts the URL and title to the desktop', () => {
    const { windows, posted } = install();
    windows.openUrl('https://example.com/post/1', { title: 'The post' });

    expect(posted).toEqual([
      { type: 'yaar:open-url', url: 'https://example.com/post/1', title: 'The post' },
    ]);
  });

  it('sends an empty title rather than a missing one when none is given', () => {
    const { windows, posted } = install();
    windows.openUrl('https://example.com');
    expect(posted[0]).toEqual({ type: 'yaar:open-url', url: 'https://example.com', title: '' });
  });

  it('says nothing for a non-string or empty url', () => {
    const { windows, posted } = install();
    windows.openUrl('');
    windows.openUrl(null);
    windows.openUrl(42);
    expect(posted).toEqual([]);
  });
});

describe('window.open in an app frame', () => {
  it('sends an http(s) popup to a YAAR window instead of a browser tab', () => {
    const { open, posted, opens } = install({ nativeOpen: true });
    open('https://x.com/someone/status/1', '_blank');

    expect(posted).toEqual([
      { type: 'yaar:open-url', url: 'https://x.com/someone/status/1', title: '' },
    ]);
    expect(opens).toEqual([]);
  });

  it('returns a window-shaped object, so a caller does not read it as a blocked popup', () => {
    const { open } = install({ nativeOpen: true });
    const opened = open('https://example.com', '_blank') as {
      closed: boolean;
      location: { href: string };
    };

    expect(opened).toBeTruthy();
    expect(opened.closed).toBe(false);
    expect(opened.location.href).toBe('https://example.com/');
  });

  it('resolves a relative url against the frame before handing it over', () => {
    const { open, posted } = install({ baseURI: 'https://example.com/app/index.html' });
    open('../docs/guide');
    expect(posted[0]).toEqual({
      type: 'yaar:open-url',
      url: 'https://example.com/docs/guide',
      title: '',
    });
  });

  it('leaves a scheme the desktop cannot host to the browser', () => {
    const { open, posted, opens } = install({ nativeOpen: true });
    expect(open('mailto:someone@example.com')).toBe('native-window');
    expect(open('blob:https://example.com/abc')).toBe('native-window');
    expect(posted).toEqual([]);
    expect(opens).toHaveLength(2);
  });

  it('leaves a url-less call to the browser — that caller wants a handle to write into', () => {
    const { open, posted, opens } = install({ nativeOpen: true });
    expect(open()).toBe('native-window');
    expect(open('')).toBe('native-window');
    expect(posted).toEqual([]);
    expect(opens).toEqual([
      { url: undefined, target: undefined },
      { url: '', target: undefined },
    ]);
  });

  it('honors the __yaarAllowPopups opt-out', () => {
    const { open, posted, opens, window } = install({ nativeOpen: true });
    window.__yaarAllowPopups = true;
    expect(open('https://example.com', '_blank')).toBe('native-window');
    expect(posted).toEqual([]);
    expect(opens).toEqual([{ url: 'https://example.com', target: '_blank' }]);
  });

  it('returns null rather than throwing when there is no native open to fall back to', () => {
    const { open, posted } = install();
    expect(open('mailto:someone@example.com')).toBe(null);
    expect(posted).toEqual([]);
  });
});
