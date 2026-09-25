/**
 * `yaar:device-request` — the one question a frame asks as its device SDK installs.
 *
 * The answer goes back on the asking frame's own window, addressed to *its* window: an
 * origin-isolated app cannot be pushed to on load, so this reply is the only way it
 * learns the form factor before the next change. The frame is found through the shared
 * iframe message router, which is why a sender outside every window gets nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { APP_MSG } from '@yaar/shared';
import { useDesktopStore } from '@/store';
import { toWindowKey } from '@/store/helpers';

const MONITOR_ID = '0';

interface Frame {
  received: unknown[];
  contentWindow: { postMessage: (msg: unknown) => void };
}

const mounted: HTMLElement[] = [];

/** An iframe in a window element, recording what the desktop posts to it. */
function mountFrame(windowKey: string | null): Frame {
  const received: unknown[] = [];
  const contentWindow = { postMessage: (msg: unknown) => received.push(msg) };
  const container = document.createElement('div');
  if (windowKey) container.setAttribute('data-window-id', windowKey);
  const iframe = document.createElement('iframe');
  Object.defineProperty(iframe, 'contentWindow', { value: contentWindow, writable: false });
  container.appendChild(iframe);
  document.body.appendChild(container);
  mounted.push(container);
  return { received, contentWindow };
}

function postFrom(source: unknown, data: Record<string, unknown>) {
  const Ctor = (window as unknown as { MessageEvent: typeof MessageEvent }).MessageEvent;
  const event = new Ctor('message', { data });
  // happy-dom's MessageEvent constructor doesn't accept `source` in the init dict.
  Object.defineProperty(event, 'source', { value: source, writable: false });
  window.dispatchEvent(event);
}

function openCard(id: string) {
  const key = toWindowKey(MONITOR_ID, id);
  useDesktopStore.setState((s) => ({
    windows: {
      ...s.windows,
      [key]: {
        id: key,
        title: id,
        monitorId: MONITOR_ID,
        bounds: { x: 0, y: 0, w: 400, h: 300 },
        content: { renderer: 'iframe', data: 'about:blank' },
        minimized: false,
        maximized: false,
      } as never,
    },
    zOrder: [...s.zOrder, key],
    focusedWindowId: key,
  }));
  return key;
}

describe('answering a device request', () => {
  beforeEach(() => {
    useDesktopStore.setState({
      windows: {},
      zOrder: [],
      focusedWindowId: null,
      activeMonitorId: MONITOR_ID,
      formFactor: 'mobile',
      orientation: 'landscape',
      fullscreenWindowId: null,
    });
  });
  afterEach(() => {
    for (const el of mounted.splice(0)) el.remove();
  });

  it('answers the asking frame, telling it whether its own card is full screen', () => {
    const a = openCard('a');
    const b = openCard('b');
    useDesktopStore.getState().toggleFullscreenWindow(b);
    const frameA = mountFrame(a);
    const frameB = mountFrame(b);

    postFrom(frameB.contentWindow, { type: APP_MSG.deviceRequest });
    postFrom(frameA.contentWindow, { type: APP_MSG.deviceRequest });

    expect(frameB.received).toEqual([
      {
        type: APP_MSG.deviceUpdate,
        formFactor: 'mobile',
        orientation: 'landscape',
        fullscreen: true,
      },
    ]);
    expect(frameA.received).toEqual([
      {
        type: APP_MSG.deviceUpdate,
        formFactor: 'mobile',
        orientation: 'landscape',
        fullscreen: false,
      },
    ]);
  });

  it('does not answer a sender outside every window', () => {
    const stray = mountFrame(null);
    postFrom(stray.contentWindow, { type: APP_MSG.deviceRequest });
    expect(stray.received).toEqual([]);
  });
});
