/**
 * `yaar:download` — an app frame's `downloadBlob()` handed to the shell inside YAAR's native
 * window. The shell saves through the host only for a frame inside a desktop window, only
 * with a host that can `download`, and only for a well-formed message.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { APP_MSG, YAAR_HOST_VERSION, type YaarHost } from '@yaar/shared';
import { useDesktopStore } from '@/store';

let saved: { name: string; mime: string; bytes: ArrayBuffer }[];
const mounted: HTMLElement[] = [];

function mountFrame(inWindow: boolean) {
  const container = document.createElement('div');
  if (inWindow) container.setAttribute('data-window-id', 'w1');
  const iframe = document.createElement('iframe');
  const contentWindow = { postMessage: () => {} };
  Object.defineProperty(iframe, 'contentWindow', { value: contentWindow, writable: false });
  container.appendChild(iframe);
  document.body.appendChild(container);
  mounted.push(container);
  return contentWindow;
}

function postFrom(source: unknown, data: Record<string, unknown>) {
  const Ctor = (window as unknown as { MessageEvent: typeof MessageEvent }).MessageEvent;
  const event = new Ctor('message', { data });
  Object.defineProperty(event, 'source', { value: source, writable: false });
  window.dispatchEvent(event);
}

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  saved = [];
  useDesktopStore.setState({ toasts: {} });
  window.yaarHost = {
    version: YAAR_HOST_VERSION,
    platform: 'macos',
    caps: ['download'],
    download: async (f) => {
      saved.push(f);
      return { savedTo: `~/Downloads/${f.name}` };
    },
    clipboard: { readText: async () => '', writeText: async () => {} },
    openExternal: () => {},
    on: () => () => {},
  } as YaarHost;
});

afterEach(() => {
  delete window.yaarHost;
  for (const el of mounted.splice(0)) el.remove();
});

describe('yaar:download', () => {
  it('saves a file from a window frame and toasts the path', async () => {
    const src = mountFrame(true);
    postFrom(src, {
      type: APP_MSG.download,
      name: '../etc/log.json',
      mime: 'application/json',
      bytes: new ArrayBuffer(4),
    });
    await tick();
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe('-etc-log.json');
    expect(saved[0].mime).toBe('application/json');
    const toasts = Object.values(useDesktopStore.getState().toasts);
    expect(toasts.map((t) => t.message)).toEqual(['Saved to ~/Downloads/-etc-log.json']);
  });

  it('ignores a sender that is not inside a window', async () => {
    const src = mountFrame(false);
    postFrom(src, { type: APP_MSG.download, name: 'a', mime: '', bytes: new ArrayBuffer(1) });
    await tick();
    expect(saved).toHaveLength(0);
  });

  it('ignores a malformed payload', async () => {
    const src = mountFrame(true);
    postFrom(src, { type: APP_MSG.download, name: 'a', mime: '', bytes: 'not bytes' });
    postFrom(src, { type: APP_MSG.download, name: 5, mime: '', bytes: new ArrayBuffer(1) });
    await tick();
    expect(saved).toHaveLength(0);
  });

  it('does nothing when the shell has no host', async () => {
    delete window.yaarHost;
    const src = mountFrame(true);
    postFrom(src, { type: APP_MSG.download, name: 'a', mime: '', bytes: new ArrayBuffer(1) });
    await tick();
    expect(saved).toHaveLength(0);
  });
});
