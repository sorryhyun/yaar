/**
 * Drops onto a window, desktop side — who receives them (`iframe-bridge/drop.ts`).
 *
 * By default a drop wakes an agent with a `<ui:*>` gesture message. An app that claimed a
 * kind with `app.onDrop` gets that kind instead, and the desktop decides from the claim it
 * already holds — no round trip into the iframe. The cases below pin both halves, and the
 * ways a stale claim must fall back to the agent rather than deliver to nothing: the frame
 * restating an empty claim on reload, the window closing, and the frame disappearing.
 *
 * Drops on the frame (`useWindowDrop`) and on the content (`yaar:file-drop`, forwarded by
 * the iframe's own script) must reach the same decision, so both entrances are exercised.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { useDesktopStore, dropFilesOnWindow, dropTextOnWindow } from '@/store';
import { notifyIframeClose } from '@/store/iframe-bridge';

function postFromIframe(data: Record<string, unknown>, source: unknown) {
  // happy-dom's `window.MessageEvent` and the global one are different classes, and
  // `dispatchEvent` only accepts the window's own.
  const Ctor = (window as unknown as { MessageEvent: typeof MessageEvent }).MessageEvent;
  const event = new Ctor('message', { data });
  Object.defineProperty(event, 'source', { value: source, writable: false });
  window.dispatchEvent(event);
}

/** A window with an app iframe, recording what the desktop posts into it. */
function mountWindow(windowId: string) {
  const received: Array<Record<string, unknown>> = [];
  const container = document.createElement('div');
  container.setAttribute('data-window-id', windowId);
  const iframe = document.createElement('iframe');
  container.appendChild(iframe);
  document.body.appendChild(container);
  const contentWindow = {
    postMessage(msg: Record<string, unknown>) {
      if (msg.type === 'yaar:drop') received.push(msg);
    },
  };
  Object.defineProperty(iframe, 'contentWindow', { value: contentWindow, writable: false });
  const claim = (kinds: unknown) =>
    postFromIframe({ type: 'yaar:drop-accept', kinds }, contentWindow);
  // What the protocol script does when it installs. The desktop's claims outlive a frame
  // and these windows reuse ids across cases, so a mount that skipped it would inherit the
  // previous case's claim — the stale-claim fault the restatement exists to prevent.
  claim([]);
  return {
    received,
    claim,
    dropFromContent: (files: unknown[]) =>
      postFromIframe({ type: 'yaar:file-drop', files }, contentWindow),
    unmount: () => container.remove(),
  };
}

function gestures(): string[] {
  return useDesktopStore.getState().pendingGestureMessages;
}

/** Let the upload promise chain settle. */
async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

let uploads: string[] = [];
let fetchSpy: ReturnType<typeof spyOn> | null = null;

beforeEach(() => {
  document.body.innerHTML = '';
  useDesktopStore.setState({ windows: {}, pendingGestureMessages: [] });
  uploads = [];
  // The agent path uploads through `apiFetch`; answer it here so no request leaves.
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => {
    uploads.push(String(input));
    return new Response(null, { status: 200 });
  }) as typeof fetch);
});

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = null;
});

describe('text dropped on a window', () => {
  it('goes to the agent when the app claimed nothing', () => {
    mountWindow('0/memo');
    dropTextOnWindow('0/memo', 'hello', '0/notes');
    expect(gestures()).toHaveLength(1);
    expect(gestures()[0]).toContain('selected_text: "hello"');
    expect(gestures()[0]).toContain('target: window "0/memo" (id: 0/memo)');
  });

  it('goes to the app, with its source window, when the app claimed text', () => {
    const win = mountWindow('0/memo');
    win.claim(['text']);
    dropTextOnWindow('0/memo', 'hello', '0/notes');
    expect(win.received).toEqual([
      {
        type: 'yaar:drop',
        kind: 'text',
        text: 'hello',
        source: { windowId: '0/notes', title: '0/notes' },
      },
    ]);
    expect(gestures()).toEqual([]);
  });

  it('still goes to the agent when the app claimed only files', () => {
    const win = mountWindow('0/memo');
    win.claim(['files']);
    dropTextOnWindow('0/memo', 'hello', '0/notes');
    expect(win.received).toEqual([]);
    expect(gestures()).toHaveLength(1);
  });
});

describe('files dropped on a window', () => {
  it('are handed to an app that claimed files, without uploading', async () => {
    const win = mountWindow('0/editor');
    win.claim(['files']);
    const file = new File(['x'], 'notes.txt', { type: 'text/plain' });
    dropFilesOnWindow('0/editor', [file]);
    await flush();
    expect(win.received).toHaveLength(1);
    expect(win.received[0].kind).toBe('files');
    expect(win.received[0].files).toEqual([file]);
    expect(uploads).toEqual([]);
    expect(gestures()).toEqual([]);
  });

  it('are uploaded and announced to the agent, naming the window, otherwise', async () => {
    mountWindow('0/editor');
    dropFilesOnWindow('0/editor', [new File(['x'], 'notes.txt', { type: 'text/plain' })]);
    await flush();
    expect(uploads).toHaveLength(1);
    expect(gestures()).toHaveLength(1);
    expect(gestures()[0]).toMatch(/^<ui:file_drop>\n {2}file: files\/drop-.*notes\.txt\n/);
    expect(gestures()[0]).toContain('source: window "0/editor" (id: 0/editor)');
  });

  it('reach the same decision when dropped on the content', async () => {
    const win = mountWindow('0/editor');
    win.claim(['files']);
    win.dropFromContent([new File(['x'], 'a.txt'), 'not a file']);
    await flush();
    expect(win.received).toHaveLength(1);
    expect((win.received[0].files as File[]).map((f) => f.name)).toEqual(['a.txt']);
  });
});

describe('a stale claim falls back to the agent', () => {
  it('when the frame restates an empty claim (a reload without the hook)', () => {
    const win = mountWindow('0/memo');
    win.claim(['text']);
    win.claim([]);
    dropTextOnWindow('0/memo', 'hello', '0/notes');
    expect(win.received).toEqual([]);
    expect(gestures()).toHaveLength(1);
  });

  it('when the window closes', () => {
    const win = mountWindow('0/memo');
    win.claim(['text']);
    notifyIframeClose('0/memo');
    dropTextOnWindow('0/memo', 'hello', '0/notes');
    expect(win.received).toEqual([]);
    expect(gestures()).toHaveLength(1);
  });

  it('when the frame is gone', () => {
    const win = mountWindow('0/memo');
    win.claim(['text']);
    win.unmount();
    dropTextOnWindow('0/memo', 'hello', '0/notes');
    expect(gestures()).toHaveLength(1);
  });

  it('when the claim names no kind the desktop knows', () => {
    const win = mountWindow('0/memo');
    win.claim(['everything', 42]);
    dropTextOnWindow('0/memo', 'hello', '0/notes');
    expect(win.received).toEqual([]);
    expect(gestures()).toHaveLength(1);
  });
});
