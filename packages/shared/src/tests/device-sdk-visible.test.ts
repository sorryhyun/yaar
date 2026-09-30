/**
 * `yaar.device.visible` — whether anyone can see the frame.
 *
 * Two sources, either of which hides it: the desktop's `visible` (a minimized window, or
 * one on another monitor, stays mounted under `visibility: hidden`, so the frame's own
 * `document.visibilityState` never changes), and the page's own `visibilitychange` (a
 * backgrounded tab or phone). The script is ES5 injected into an iframe, so it is run the
 * way the browser runs it, over stub globals.
 */
import { describe, it, expect } from 'bun:test';
import { APP_MSG } from '../app-protocol.js';
import { IFRAME_DEVICE_SDK_SCRIPT } from '../iframe-scripts/device-sdk.js';

interface DeviceState {
  visible: boolean;
}

function installDevice() {
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const on = (type: string, fn: (e: unknown) => void) => (listeners[type] ??= []).push(fn);
  const fire = (type: string, e?: unknown) => listeners[type]?.forEach((fn) => fn(e));

  const document = {
    visibilityState: 'visible',
    documentElement: { setAttribute() {}, removeAttribute() {} },
    addEventListener: on,
  };
  const parent = { postMessage() {} };
  const window = {
    innerWidth: 800,
    innerHeight: 600,
    addEventListener: on,
    parent,
  } as Record<string, unknown>;

  new Function('window', 'document', 'screen', IFRAME_DEVICE_SDK_SCRIPT)(window, document, {});

  const device = (
    window.yaar as {
      device: { get(): DeviceState; onChange(cb: (s: DeviceState) => void): () => void };
    }
  ).device;
  const seen: boolean[] = [];
  device.onChange((s) => seen.push(s.visible));

  return {
    device,
    seen,
    desktop(visible?: boolean) {
      fire('message', {
        data: {
          type: APP_MSG.deviceUpdate,
          formFactor: 'desktop',
          orientation: 'landscape',
          fullscreen: false,
          ...(visible === undefined ? {} : { visible }),
          host: null,
        },
      });
    },
    page(state: 'visible' | 'hidden') {
      document.visibilityState = state;
      fire('visibilitychange');
    },
  };
}

describe('device.visible', () => {
  it('follows the desktop hiding and showing the window', () => {
    const d = installDevice();
    d.desktop(false);
    d.desktop(true);
    expect(d.seen).toEqual([true, false, true]);
  });

  it('follows the page being backgrounded', () => {
    const d = installDevice();
    d.page('hidden');
    d.page('visible');
    expect(d.seen).toEqual([true, false, true]);
  });

  it('stays hidden until both say shown', () => {
    const d = installDevice();
    d.desktop(false);
    d.page('hidden');
    d.desktop(true);
    expect(d.device.get().visible).toBe(false);
    d.page('visible');
    expect(d.seen).toEqual([true, false, true]);
  });

  it('reads a desktop that never sends the field as shown', () => {
    const d = installDevice();
    d.desktop();
    expect(d.device.get().visible).toBe(true);
  });
});
