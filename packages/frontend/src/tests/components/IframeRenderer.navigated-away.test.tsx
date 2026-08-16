/**
 * An app frame that stops being the app has to say so.
 *
 * No sandbox token governs a frame navigating *itself* — the `allow-top-navigation`
 * family only covers the top-level context — so a link, a form submit, a
 * `location.href` or a meta refresh in app-rendered HTML replaces the app document
 * and every script injected into it, the app protocol bridge included. Nothing
 * throws and nothing logs; the app simply stops answering, which from the outside
 * is indistinguishable from a crash.
 *
 * The bridge's link guard prevents the common cause, but it is baked into each
 * app's `dist/` and cannot help an app built before it. This detector needs
 * nothing from inside the frame: a *second* load event on a frame whose document
 * is no longer the app's is the whole signal.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { useDesktopStore } from '@/store';
import { MemoizedIframeRenderer } from '@/components/window/renderers/IframeRenderer';

function setUrl(url: string): void {
  (window as unknown as { happyDOM?: { setURL(u: string): void } }).happyDOM?.setURL(url);
}

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
