/**
 * A link in app-rendered HTML must not navigate the app's own document away.
 *
 * An app frame is same-origin and unsandboxed, and no sandbox token governs a frame
 * navigating *itself* — the `allow-top-navigation` family only governs the top-level
 * context — so nothing at the frame level could have stopped this. A plain
 * `<a href>` replaced the app document and every script injected into it, the app
 * protocol bridge included: no exception, no console output, and an app that simply
 * stopped answering.
 *
 * The cases below split three ways, and the middle group is the one that changed:
 *
 *  - what the guard intercepts, which is now every activation that would replace the
 *    app's document — `target="_blank"` and modified clicks included. Those two used
 *    to be exempt, on the reasoning that the user had asked the browser for a new
 *    tab. There is no tab to ask for inside YAAR, so the exemption meant leaving the
 *    desktop or hitting the popup blocker; since `target="_blank"` is how anyone
 *    writes an external link, it covered most real links in most real apps and was
 *    why three apps had hand-rolled a stricter guard of their own.
 *  - what it stands aside for, which is now exactly the activations that do NOT
 *    replace the document (a download, a right click, a frame the app owns) plus the
 *    two cooperation points: a click the app already handled, and `links.onOpen`.
 *  - `links.onOpen` itself — rewrite, claim, and the throwing handler.
 *
 * The script is ES5 injected into an iframe, so it's exercised the way the browser
 * runs it — evaluated with stub globals — rather than pattern-matched.
 */
import { describe, it, expect } from 'bun:test';
import { IFRAME_WINDOWS_SDK_SCRIPT } from '../iframe-scripts/windows-sdk.js';

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
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  /** Fire as `auxclick` (the middle button) rather than `click`. */
  aux?: boolean;
}

type LinkHandler = (url: string, anchor: unknown) => string | false | void;

interface Harness {
  /** Click an anchor; returns the posted frame, or null when the guard stood aside. */
  click: (anchor: Anchor | null, opts?: ClickOptions) => Posted | null;
  prevented: () => boolean;
  onOpen: (fn: LinkHandler) => void;
  window: Record<string, unknown>;
}

/**
 * Install the script against stub globals.
 *
 * `app` decides whether the frame looks like an app at all: a compiled app carries
 * `window.__yaar_links__` (the compiler emits it for every app, empty or not) and a
 * registered one sets `__yaarAppRegistered`. Neither means a plain HTML document in
 * a window, which must keep browsing in place.
 */
function install({
  app = true,
  base,
  framedTargets = [],
}: { app?: boolean; base?: string; framedTargets?: string[] } = {}): Harness {
  const posted: Posted[] = [];
  const listeners: Record<string, (e: unknown) => void> = {};
  let prevented = false;

  const window = {
    __yaarWindowsInstalled: false,
    ...(app ? { __yaar_links__: base ? { base } : {} } : {}),
    parent: { postMessage: (msg: Posted) => posted.push(msg) },
  } as Record<string, unknown>;
  const document = {
    baseURI: APP_URL,
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      listeners[type] = fn;
    },
    // Only a target the app itself frames counts as "already says where this goes".
    querySelector: (sel: string) => framedTargets.find((n) => sel.includes(`"${n}"`)) ?? null,
  };
  const location = { href: APP_URL };

  new Function('window', 'document', 'location', IFRAME_WINDOWS_SDK_SCRIPT)(
    window,
    document,
    location,
  );

  const links = (window.yaar as { links: { onOpen: (fn: LinkHandler) => void } }).links;

  return {
    window,
    prevented: () => prevented,
    onOpen: (fn) => links.onOpen(fn),
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
      listeners[opts.aux ? 'auxclick' : 'click']?.({
        defaultPrevented: opts.defaultPrevented ?? false,
        button: opts.button ?? (opts.aux ? 1 : 0),
        ctrlKey: opts.ctrlKey ?? false,
        metaKey: opts.metaKey ?? false,
        shiftKey: opts.shiftKey ?? false,
        altKey: opts.altKey ?? false,
        target: { closest: () => el },
        preventDefault: () => {
          prevented = true;
        },
      });
      return posted.find((m) => m.type === 'yaar:open-url') ?? null;
    },
  };
}

describe('app link guard — what it intercepts', () => {
  it('hands an external link to the desktop instead of letting it replace the app', () => {
    const app = install();
    const sent = app.click({ href: 'https://example.com/post/1', text: 'Read the post' });

    expect(app.prevented()).toBe(true);
    expect(sent).toMatchObject({
      url: 'https://example.com/post/1',
      title: 'Read the post',
    });
  });

  it('catches target="_blank", which is how an external link is normally written', () => {
    // The exemption this replaces made the guard a no-op for most real links: an
    // app frame cannot open a browser tab, so the click either left YAAR or was
    // swallowed by the popup blocker ("links in this app do nothing").
    const app = install();
    const sent = app.click({ href: 'https://example.com', target: '_blank' });
    expect(app.prevented()).toBe(true);
    expect(sent?.url).toBe('https://example.com/');
  });

  it('catches _top and _parent, which aim at the desktop itself', () => {
    const app = install();
    expect(app.click({ href: 'https://example.com/a', target: '_top' })?.url).toBe(
      'https://example.com/a',
    );
    expect(app.click({ href: 'https://example.com/b', target: '_parent' })?.url).toBe(
      'https://example.com/b',
    );
  });

  it('catches a named target with no frame behind it — that is a popup, not a frame', () => {
    const app = install();
    expect(app.click({ href: 'https://example.com', target: 'viewer' })?.url).toBe(
      'https://example.com/',
    );
  });

  it('catches the middle click, which is its own navigation and never fires as a click', () => {
    const app = install();
    const sent = app.click({ href: 'https://example.com/mid' }, { aux: true });
    expect(app.prevented()).toBe(true);
    expect(sent?.url).toBe('https://example.com/mid');
  });

  it('catches ctrl/cmd/shift-click — "new tab" here means a YAAR window', () => {
    const app = install();
    expect(app.click({ href: 'https://example.com/1' }, { ctrlKey: true })?.url).toBe(
      'https://example.com/1',
    );
    expect(app.click({ href: 'https://example.com/2' }, { metaKey: true })?.url).toBe(
      'https://example.com/2',
    );
    expect(app.click({ href: 'https://example.com/3' }, { shiftKey: true })?.url).toBe(
      'https://example.com/3',
    );
  });

  it('catches the root-relative href, which lands on the shell, not the app', () => {
    // `/board/123` is same-origin, so it silently swapped the app for a shell 404 —
    // the exact shape of the original report.
    const sent = install().click({ href: '/board/123' });
    expect(sent?.url).toBe('http://localhost:8000/board/123');
  });

  it('resolves a relative href against the site the content came from, when declared', () => {
    // app.json's "links": { "base": ... }. Without it a DC post body's `/board/123`
    // resolves against the shell and 404s — the app cannot be asked to rewrite every
    // href in HTML it did not author.
    const app = install({ base: 'https://m.dcinside.com' });
    expect(app.click({ href: '/board/thesingularity/123' })?.url).toBe(
      'https://m.dcinside.com/board/thesingularity/123',
    );
  });
});

describe('app link guard — what it stands aside for', () => {
  it('leaves a same-document fragment link alone', () => {
    const app = install();
    expect(app.click({ href: '#section-2' })).toBeNull();
    expect(app.prevented()).toBe(false);
  });

  it('leaves a link back to the app itself alone, even with a base configured', () => {
    // The base governs the foreign content an app renders; the app's own document is
    // still its own document.
    for (const app of [install(), install({ base: 'https://m.dcinside.com' })]) {
      expect(app.click({ href: 'index.html#top' })).toBeNull();
      expect(app.prevented()).toBe(false);
    }
  });

  it('leaves a download and a right click alone — neither replaces the document', () => {
    const app = install();
    expect(app.click({ href: 'https://example.com/f.zip', download: true })).toBeNull();
    expect(app.click({ href: 'https://example.com' }, { aux: true, button: 2 })).toBeNull();
    expect(app.click({ href: 'https://example.com' }, { altKey: true })).toBeNull();
    expect(app.prevented()).toBe(false);
  });

  it('leaves a target the app itself frames alone', () => {
    const app = install({ framedTargets: ['viewer'] });
    expect(app.click({ href: 'https://example.com', target: 'viewer' })).toBeNull();
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

  it('does not arm for a plain document that is not an app', () => {
    // A previewed HTML file in a window is not an app and should keep browsing in place.
    const plain = install({ app: false });
    expect(plain.click({ href: 'https://example.com' })).toBeNull();
    expect(plain.prevented()).toBe(false);
  });

  it('arms for an app that registered before the compiler emitted a links block', () => {
    const app = install({ app: false });
    app.window.__yaarAppRegistered = true;
    expect(app.click({ href: 'https://example.com' })?.url).toBe('https://example.com/');
  });

  it('can be opted out of by an app that means to navigate its frame', () => {
    const app = install();
    app.window.__yaarAllowFrameNavigation = true;
    expect(app.click({ href: 'https://example.com' })).toBeNull();
    expect(app.prevented()).toBe(false);
  });
});

describe('links.onOpen', () => {
  it('opens the URL the handler returns instead of the one clicked', () => {
    // The redirect-interstitial case: the site wraps outbound links in its own
    // warning page carrying the real destination in a query parameter.
    const app = install();
    app.onOpen((url) => {
      const target = new URL(url).searchParams.get('url');
      return target ?? url;
    });
    const sent = app.click({ href: 'https://site.example/link?url=https%3A%2F%2Freal.example' });
    expect(sent?.url).toBe('https://real.example/');
  });

  it('opens no window when the handler claims the link', () => {
    // In-app routing: a link to a post this app already renders is navigation
    // *within* the app, so nothing should open at all — but the click must still be
    // cancelled, or the frame navigates while the app routes.
    const app = install();
    const seen: string[] = [];
    app.onOpen((url) => {
      seen.push(url);
      return false;
    });
    expect(app.click({ href: 'https://example.com/post/9' })).toBeNull();
    expect(app.prevented()).toBe(true);
    expect(seen).toEqual(['https://example.com/post/9']);
  });

  it('passes the anchor, so a decision can read the markup it came from', () => {
    const app = install();
    let sawText: unknown = null;
    app.onOpen((_url, anchor) => {
      sawText = (anchor as { textContent?: string } | null)?.textContent;
    });
    app.click({ href: 'https://example.com', text: 'Open on GitHub' });
    expect(sawText).toBe('Open on GitHub');
  });

  it('opens the link unchanged when the handler throws', () => {
    // A bug in an app's routing must not resurrect the failure the guard exists to
    // prevent — a swallowed link is indistinguishable from a dead app.
    const app = install();
    app.onOpen(() => {
      throw new Error('boom');
    });
    expect(app.click({ href: 'https://example.com/x' })?.url).toBe('https://example.com/x');
  });

  it('drops a rewrite that is not openable rather than opening the original', () => {
    const app = install();
    app.onOpen(() => 'mailto:someone@example.com');
    expect(app.click({ href: 'https://example.com' })).toBeNull();
    expect(app.prevented()).toBe(true);
  });
});
