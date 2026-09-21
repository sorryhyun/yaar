/**
 * IframeRenderer: the app-origin-isolation sandbox policy, and detecting an app
 * frame that navigates itself away.
 *
 * Sandbox policy (docs/guides/remote_mode.md): the security-load-bearing fact is a
 * *negative* — an isolated app frame must never carry the top-navigation capability,
 * or it regains the desktop-swap phishing vector the isolation was meant to close.
 * The equally important *positive* is that `allow-same-origin` survives — dropping it
 * is what re-breaks the DC-comics class of blob/localStorage flows. happy-dom does not
 * *enforce* sandbox, so these assert the attribute the browser is handed; the actual
 * enforcement is confirmed by a live render (see the PR notes), which no unit runner
 * can stand in for.
 *
 * Navigated-away detection: no sandbox token governs a frame navigating *itself* — the
 * `allow-top-navigation` family only covers the top-level context — so a link, a form
 * submit, a `location.href` or a meta refresh in app-rendered HTML replaces the app
 * document and every script injected into it, the app protocol bridge included.
 * Nothing throws and nothing logs; the app simply stops answering, which from the
 * outside is indistinguishable from a crash. The bridge's link guard prevents the
 * common cause, but it is baked into each app's `dist/` and cannot help an app built
 * before it. This detector needs nothing from inside the frame: a *second* load event
 * on a frame whose document is no longer the app's is the whole signal.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { useDesktopStore } from '@/store';
import {
  MemoizedIframeRenderer,
  ISOLATED_APP_SANDBOX,
  APP_FRAME_ALLOW,
  EXTERNAL_FRAME_ALLOW,
} from '@/components/window/renderers/IframeRenderer';

/** happy-dom exposes `setURL` off `window.happyDOM`; it isn't in the DOM lib types. */
function setUrl(url: string): void {
  (window as unknown as { happyDOM?: { setURL(u: string): void } }).happyDOM?.setURL(url);
}

const TOP_NAV_TOKENS = [
  'allow-top-navigation',
  'allow-top-navigation-by-user-activation',
  'allow-top-navigation-to-custom-protocols',
];

const APP_URL = '/apps/reader/index.html';

/** Point the frame's document somewhere, the way a navigation would. */
function pointFrameAt(iframe: HTMLIFrameElement, href: string) {
  Object.defineProperty(iframe, 'contentWindow', {
    configurable: true,
    value: { location: { href } },
  });
}

/** What a browser does once the frame is on another origin: reading `location` throws. */
function pointFrameOffOrigin(iframe: HTMLIFrameElement) {
  Object.defineProperty(iframe, 'contentWindow', {
    configurable: true,
    value: {
      get location(): never {
        throw new Error('SecurityError: Blocked a frame from accessing a cross-origin frame.');
      },
    },
  });
}

function renderApp(props: { appId?: string } = {}) {
  const { container } = render(<MemoizedIframeRenderer data={APP_URL} {...props} />);
  const iframe = container.querySelector('iframe') as HTMLIFrameElement;
  fireEvent.load(iframe); // First load: this is the app.
  return { container, iframe };
}

describe('ISOLATED_APP_SANDBOX policy', () => {
  it('withholds every top-navigation token', () => {
    const tokens = ISOLATED_APP_SANDBOX.split(' ');
    for (const forbidden of TOP_NAV_TOKENS) {
      expect(tokens).not.toContain(forbidden);
    }
  });

  it('keeps allow-same-origin (blob / localStorage / cookies / __yaar_api fetch)', () => {
    // Dropping this is what re-broke the DC-comics gallery once — the frame loses its
    // 127.0.0.1 identity and can no longer fetch its own object-URLs.
    expect(ISOLATED_APP_SANDBOX.split(' ')).toContain('allow-same-origin');
  });

  it('keeps the capabilities apps actually use (scripts, forms, popups)', () => {
    const tokens = ISOLATED_APP_SANDBOX.split(' ');
    expect(tokens).toContain('allow-scripts');
    expect(tokens).toContain('allow-forms');
    expect(tokens).toContain('allow-popups');
  });
});

describe('IframeRenderer sandbox wiring', () => {
  const originalHref = window.location.href;

  beforeEach(() => {
    // appOrigin only resolves when the desktop is on localhost (siblingLoopbackOrigin).
    setUrl('http://localhost:8000/');
    useDesktopStore.setState({ sessionId: 'sess-1', notifications: {} });
  });

  afterEach(() => {
    cleanup();
    setUrl(originalHref);
  });

  it('applies ISOLATED_APP_SANDBOX to an isolated (cross-origin) app frame', () => {
    const { container } = render(
      <MemoizedIframeRenderer data="/apps/notes/index.html" isolateOrigin iframeToken="tok-1" />,
    );
    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute('sandbox')).toBe(ISOLATED_APP_SANDBOX);
    // And the src really is on the cross-origin app alias, so the sandbox is guarding
    // a genuinely isolated frame, not a same-origin one.
    expect(iframe?.getAttribute('src')).toContain('127.0.0.1:8000');
  });

  it('leaves a trusted same-origin app unsandboxed', () => {
    const { container } = render(
      <MemoizedIframeRenderer data="/apps/notes/index.html" iframeToken="tok-1" />,
    );
    const iframe = container.querySelector('iframe');
    expect(iframe?.getAttribute('sandbox')).toBeNull();
  });

  // `microphone` defaults to 'self': without delegation an isolated app's getUserMedia
  // is refused with no prompt at all.
  it('delegates the microphone to isolated and same-origin app frames', () => {
    for (const isolateOrigin of [true, false]) {
      const { container } = render(
        <MemoizedIframeRenderer
          data="/apps/notes/index.html"
          isolateOrigin={isolateOrigin}
          iframeToken="tok-1"
        />,
      );
      expect(container.querySelector('iframe')?.getAttribute('allow')).toBe(APP_FRAME_ALLOW);
      cleanup();
    }
    expect(APP_FRAME_ALLOW.split('; ')).toContain('microphone');
  });

  // A delegated frame's prompt is attributed to the top origin, so an external embed
  // would ask for the mic in the desktop's name.
  it('withholds the microphone from an external embed', () => {
    const { container } = render(<MemoizedIframeRenderer data="https://example.com/" />);
    const allow = container.querySelector('iframe')?.getAttribute('allow') ?? '';
    expect(allow).toBe(EXTERNAL_FRAME_ALLOW);
    expect(allow.split('; ')).not.toContain('microphone');
  });
});

/**
 * App-origin isolation over a remote transport (Phase 3 of the Tailscale migration).
 *
 * There, the two origins are two ports on one hostname (`https://box.ts.net` and
 * `https://box.ts.net:8443`) and nothing standing on the client can compute the second
 * from the first — so the server names it on the create action and we obey. The
 * sibling-loopback derivation is the *fallback*, not the rule.
 */
describe('IframeRenderer — server-named app origin', () => {
  const originalHref = window.location.href;
  const APP_ORIGIN = 'https://box.tailnet-abc.ts.net:8443';

  beforeEach(() => {
    setUrl('https://box.tailnet-abc.ts.net/');
    useDesktopStore.setState({ sessionId: 'sess-1', notifications: {} });
  });

  afterEach(() => {
    cleanup();
    setUrl(originalHref);
  });

  it('serves the frame from the origin the server named, and sandboxes it', () => {
    const { container } = render(
      <MemoizedIframeRenderer
        data="/api/apps/notes/index.html"
        isolateOrigin
        appOrigin={APP_ORIGIN}
        iframeToken="tok-1"
      />,
    );
    const src = container.querySelector('iframe')?.getAttribute('src') ?? '';
    expect(src).toStartWith(`${APP_ORIGIN}/api/apps/notes/index.html`);
    // The desktop origin rides along as __yaar_api — without it the app's SDK would call
    // its own origin and never reach the backend.
    expect(new URL(src).searchParams.get('__yaar_api')).toBe('https://box.tailnet-abc.ts.net');
    expect(new URL(src).searchParams.get('__yaar_token')).toBe('tok-1');
    expect(container.querySelector('iframe')?.getAttribute('sandbox')).toBe(ISOLATED_APP_SANDBOX);
  });

  it('does not isolate without the server mark, even given an origin', () => {
    const { container } = render(
      <MemoizedIframeRenderer data="/api/apps/notes/index.html" appOrigin={APP_ORIGIN} />,
    );
    const src = container.querySelector('iframe')?.getAttribute('src') ?? '';
    expect(src).not.toContain(':8443');
  });

  it('stays same-origin off localhost when the server named nothing', () => {
    // The old behavior, and why Phase 3 needed the server to speak up: the
    // sibling-loopback trick has nothing to derive from here.
    const { container } = render(
      <MemoizedIframeRenderer data="/api/apps/notes/index.html" isolateOrigin />,
    );
    const src = container.querySelector('iframe')?.getAttribute('src') ?? '';
    expect(src).toStartWith('/api/apps/notes/index.html');
  });
});

describe('an app frame that navigates itself away', () => {
  const originalHref = window.location.href;

  beforeEach(() => {
    setUrl('http://localhost:8000/');
    useDesktopStore.setState({ sessionId: 'sess-1', notifications: {} });
  });

  afterEach(() => {
    cleanup();
    setUrl(originalHref);
  });

  it('reports the destination instead of leaving a dead frame on screen', () => {
    const { container, iframe } = renderApp({ appId: 'reader' });

    pointFrameAt(iframe, 'https://example.com/post/1');
    fireEvent.load(iframe);

    expect(screen.getByText('This app navigated away')).toBeTruthy();
    expect(container.textContent).toContain('https://example.com/post/1');
    // The dead document is gone from the page, not left there looking alive.
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('reports a walk-off to another origin, where the destination is unreadable', () => {
    // The loudest case, and the one a naive readability check swallows: an external
    // link puts the frame on another origin, so `location` throws instead of
    // answering. That throw *is* the evidence — a same-origin app frame that can no
    // longer be read is no longer the app.
    const { container, iframe } = renderApp({ appId: 'reader' });

    pointFrameOffOrigin(iframe);
    fireEvent.load(iframe);

    expect(screen.getByText('This app navigated away')).toBeTruthy();
    expect(container.textContent).toContain('another site');
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('offers a way back, which remounts the frame at the app', () => {
    const { container, iframe } = renderApp({ appId: 'reader' });
    pointFrameAt(iframe, 'https://example.com/post/1');
    fireEvent.load(iframe);

    fireEvent.click(screen.getByText('Reload app'));

    const fresh = container.querySelector('iframe');
    expect(fresh).not.toBeNull();
    expect(fresh?.getAttribute('src')).toStartWith(APP_URL);
  });

  it('says nothing when the app reloads itself', () => {
    // `location.reload()`, or a devtools preview rebuilding: same document, and the
    // query string it carries (sessionId, token) is not part of the comparison.
    const { container, iframe } = renderApp({ appId: 'reader' });

    pointFrameAt(iframe, `http://localhost:8000${APP_URL}?sessionId=sess-1`);
    fireEvent.load(iframe);

    expect(container.querySelector('iframe')).not.toBeNull();
  });

  it('leaves a plain web page free to browse in place', () => {
    // Only an app frame is making a promise about staying the app. A window on a
    // website is expected to follow its own links.
    const { container, iframe } = renderApp();

    pointFrameAt(iframe, 'https://example.com/somewhere-else');
    fireEvent.load(iframe);

    expect(container.querySelector('iframe')).not.toBeNull();
  });
});
