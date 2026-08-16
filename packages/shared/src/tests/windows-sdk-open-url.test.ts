/**
 * `yaar.windows.openUrl` — the way an app hands a URL somewhere without leaving.
 *
 * Before it, an app's only outs were `window.open` (a browser tab, outside YAAR)
 * and a plain link (which navigates the app's own frame and takes the app protocol
 * with it). The windows SDK is otherwise read-only; this is the one write, and it
 * is fire-and-forget because the desktop owns window creation.
 */
import { describe, it, expect } from 'bun:test';
import { IFRAME_WINDOWS_SDK_SCRIPT } from '../iframe-scripts/windows-sdk.js';

interface Posted {
  type: string;
  url?: string;
  title?: string;
}

function install() {
  const posted: Posted[] = [];
  const window = {
    __yaarWindowsInstalled: false,
    parent: { postMessage: (msg: Posted) => posted.push(msg) },
  } as Record<string, unknown>;

  new Function('window', IFRAME_WINDOWS_SDK_SCRIPT)(window);
  const windows = (window.yaar as { windows: { openUrl: (u: unknown, o?: unknown) => void } })
    .windows;
  return { windows, posted };
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
