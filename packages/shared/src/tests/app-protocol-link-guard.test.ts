/**
 * A link in app-rendered HTML must not navigate the app's own document away.
 *
 * An app frame is same-origin and unsandboxed, and no sandbox token governs a frame
 * navigating *itself* — the `allow-top-navigation` family only governs the top-level
 * context — so nothing at the frame level could have stopped this. A plain
 * `<a href>` replaced the app document and every script injected into it, the app
 * protocol bridge included: no exception, no console output, and an app that simply
 * stopped answering. Every app rendering external or user-authored HTML had to
 * rediscover the same hand-written guard.
 *
 * The guard is narrow on purpose — it declines anything the app or the user has
 * already spoken for — so the cases below are mostly about what it leaves alone.
 *
 * The script is ES5 injected into an iframe, so it's exercised the way the browser
 * runs it — evaluated with stub globals — rather than pattern-matched.
 */
import { describe, it, expect } from 'bun:test';
import { IFRAME_APP_PROTOCOL_SCRIPT } from '../iframe-scripts/app-protocol.js';

const APP_URL = 'http://localhost:8000/apps/reader/index.html';

interface Posted {
  type: string;
  url?: string;
  title?: string;
}

interface Anchor {
  href?: string;
  target?: string;
  download?: boolean;
  text?: string;
}

interface ClickOptions {
  defaultPrevented?: boolean;
  button?: number;
  ctrlKey?: boolean;
}

interface Harness {
  /** Click an anchor; returns the posted frame, or null when the guard stood aside. */
  click: (anchor: Anchor | null, opts?: ClickOptions) => Posted | null;
  prevented: () => boolean;
  window: Record<string, unknown>;
}

function install({ register = true }: { register?: boolean } = {}): Harness {
  const posted: Posted[] = [];
  let onClick: ((e: unknown) => void) | null = null;
  let prevented = false;

  const window = {
    __yaarAppProtocolInstalled: false,
    parent: { postMessage: (msg: Posted) => posted.push(msg) },
    addEventListener: () => {},
  } as Record<string, unknown>;
  const document = {
    baseURI: APP_URL,
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      if (type === 'click') onClick = fn;
    },
  };
  const location = { href: APP_URL };

  new Function('window', 'document', 'location', IFRAME_APP_PROTOCOL_SCRIPT)(
    window,
    document,
    location,
  );

  if (register) {
    (window.yaar as { app: { __registerApp: (c: unknown) => void } }).app.__registerApp({
      appId: 'reader',
      name: 'Reader',
      state: {},
      commands: {},
    });
  }

  return {
    window,
    prevented: () => prevented,
    click(anchor, opts = {}) {
      posted.length = 0;
      prevented = false;
      const el = anchor
        ? {
            getAttribute: (name: string) =>
              name === 'href' ? (anchor.href ?? null) : (anchor.target ?? null),
            hasAttribute: (name: string) => name === 'download' && !!anchor.download,
            textContent: anchor.text ?? '',
          }
        : null;
      onClick?.({
        defaultPrevented: opts.defaultPrevented ?? false,
        button: opts.button ?? 0,
        ctrlKey: opts.ctrlKey ?? false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        target: { closest: () => el },
        preventDefault: () => {
          prevented = true;
        },
      });
      return posted.find((m) => m.type === 'yaar:open-url') ?? null;
    },
  };
}

describe('app link guard', () => {
  it('hands an external link to the desktop instead of letting it replace the app', () => {
    const app = install();
    const sent = app.click({ href: 'https://example.com/post/1', text: 'Read the post' });

    expect(app.prevented()).toBe(true);
    expect(sent).toMatchObject({
      url: 'https://example.com/post/1',
      title: 'Read the post',
    });
  });

  it('catches the root-relative href too, which lands on the shell, not the app', () => {
    // `/board/123` is same-origin, so it silently swapped the app for a shell 404 —
    // the exact shape of the original report.
    const sent = install().click({ href: '/board/123' });
    expect(sent?.url).toBe('http://localhost:8000/board/123');
  });

  it('leaves a same-document fragment link alone', () => {
    const app = install();
    expect(app.click({ href: '#section-2' })).toBeNull();
    expect(app.prevented()).toBe(false);
  });

  it('leaves a link back to the app itself alone', () => {
    const app = install();
    expect(app.click({ href: 'index.html#top' })).toBeNull();
    expect(app.prevented()).toBe(false);
  });

  it('leaves a link that already says where it goes alone', () => {
    const app = install();
    expect(app.click({ href: 'https://example.com', target: '_blank' })).toBeNull();
    expect(app.click({ href: 'https://example.com/f.zip', download: true })).toBeNull();
    expect(app.prevented()).toBe(false);
  });

  it('leaves mailto: and other non-http schemes to the browser', () => {
    const app = install();
    expect(app.click({ href: 'mailto:someone@example.com' })).toBeNull();
    expect(app.click({ href: 'javascript:void 0' })).toBeNull();
    expect(app.prevented()).toBe(false);
  });

  it('stands aside for a click the app already handled', () => {
    // Bubble phase at the document, not capture: an app with its own router or
    // click handler keeps owning its links.
    const app = install();
    expect(app.click({ href: 'https://example.com' }, { defaultPrevented: true })).toBeNull();
    expect(app.prevented()).toBe(false);
  });

  it('stands aside for a modified or non-left click', () => {
    const app = install();
    expect(app.click({ href: 'https://example.com' }, { ctrlKey: true })).toBeNull();
    expect(app.click({ href: 'https://example.com' }, { button: 1 })).toBeNull();
    expect(app.prevented()).toBe(false);
  });

  it('does not arm for a plain document that registered no app', () => {
    // A previewed HTML file in a window is not an app and should keep browsing in place.
    const plain = install({ register: false });
    expect(plain.click({ href: 'https://example.com' })).toBeNull();
    expect(plain.prevented()).toBe(false);
  });

  it('can be opted out of by an app that means to navigate its frame', () => {
    const app = install();
    app.window.__yaarAllowFrameNavigation = true;
    expect(app.click({ href: 'https://example.com' })).toBeNull();
    expect(app.prevented()).toBe(false);
  });
});
