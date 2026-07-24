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
