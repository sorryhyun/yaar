/**
 * Locks the app-origin-isolation sandbox policy (docs/guides/remote_mode.md).
 *
 * The security-load-bearing fact is a *negative*: an isolated app frame must never
 * carry the top-navigation capability, or it regains the desktop-swap phishing
 * vector the isolation was meant to close. The equally important *positive* is that
 * `allow-same-origin` survives — dropping it is what re-breaks the DC-comics class
 * of blob/localStorage flows. happy-dom does not *enforce* sandbox, so these assert
 * the attribute the browser is handed; the actual enforcement is confirmed by a live
 * render (see the PR notes), which no unit runner can stand in for.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { render, cleanup } from '@testing-library/react';
import { useDesktopStore } from '@/store';
import {
  MemoizedIframeRenderer,
  ISOLATED_APP_SANDBOX,
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
