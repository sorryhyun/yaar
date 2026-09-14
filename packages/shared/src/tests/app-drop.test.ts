/**
 * Drops on a window, iframe side: `app.onDrop` and the content-area file forward.
 *
 * By default every drop on a window wakes an agent. `app.onDrop` lets an app take a kind
 * of drop over, and the desktop decides between the two without asking the iframe — so the
 * claim has to be announced up front (`yaar:drop-accept`), restated empty on every install
 * (the desktop's record outlives a reload), and never include a kind with no handler.
 *
 * Drag events do not cross into an iframe, so the window frame never saw a file dropped on
 * an app's content; the browser opened it instead. The contextmenu script now forwards such
 * a drop (`yaar:file-drop`) — but only one the app did not handle itself, because an app's
 * own drop zone must keep working as written.
 *
 * Both scripts are ES5 injected into an iframe, so they run here the way the browser runs
 * them — evaluated over a stub `window` and `document` — rather than pattern-matched.
 */
import { describe, it, expect } from 'bun:test';
import { IFRAME_APP_PROTOCOL_SCRIPT } from '../iframe-scripts/app-protocol.js';
import { IFRAME_CONTEXTMENU_SCRIPT } from '../iframe-scripts/contextmenu.js';

type Listener = (e: unknown) => void;

interface Posted {
  type: string;
  kinds?: string[];
  files?: unknown[];
}

function listenerBag() {
  const listeners = new Map<string, Listener[]>();
  return {
    listeners,
    addEventListener(type: string, fn: Listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    fire(type: string, e: unknown) {
      for (const fn of listeners.get(type) ?? []) fn(e);
    },
  };
}

interface DropHandlers {
  files?: (files: unknown[]) => unknown;
  text?: (text: string, source: unknown) => unknown;
}

function installProtocol() {
  const posted: Posted[] = [];
  const bag = listenerBag();
  const window = {
    __yaarAppProtocolInstalled: false,
    parent: { postMessage: (msg: Posted) => posted.push(msg) },
    addEventListener: bag.addEventListener,
  } as Record<string, unknown>;

  new Function('window', IFRAME_APP_PROTOCOL_SCRIPT)(window);

  const app = (window.yaar as { app: { onDrop: (h: DropHandlers | null) => void } }).app;
  const deliver = (data: Record<string, unknown>) => bag.fire('message', { data });
  return { app, posted, deliver };
}

describe('app.onDrop', () => {
  it('restates an empty claim when the script installs', () => {
    const { posted } = installProtocol();
    expect(posted).toContainEqual({ type: 'yaar:drop-accept', kinds: [] });
  });

  it('claims exactly the kinds it has handlers for', () => {
    const { app, posted } = installProtocol();
    posted.length = 0;
    app.onDrop({ files: () => {} });
    app.onDrop({ files: () => {}, text: () => {} });
    app.onDrop({ files: 'not a function' as unknown as () => void });
    expect(posted).toEqual([
      { type: 'yaar:drop-accept', kinds: ['files'] },
      { type: 'yaar:drop-accept', kinds: ['files', 'text'] },
      { type: 'yaar:drop-accept', kinds: [] },
    ]);
  });

  it('hands every drop back to the agent on null', () => {
    const { app, posted } = installProtocol();
    app.onDrop({ files: () => {} });
    posted.length = 0;
    app.onDrop(null);
    expect(posted).toEqual([{ type: 'yaar:drop-accept', kinds: [] }]);
  });

  it('delivers files and text to their handlers', () => {
    const { app, deliver } = installProtocol();
    const got: unknown[] = [];
    app.onDrop({
      files: (files) => got.push(['files', files]),
      text: (text, source) => got.push(['text', text, source]),
    });
    deliver({ type: 'yaar:drop', kind: 'files', files: ['f1', 'f2'] });
    deliver({ type: 'yaar:drop', kind: 'text', text: 'hi', source: { windowId: 'w', title: 'W' } });
    expect(got).toEqual([
      ['files', ['f1', 'f2']],
      ['text', 'hi', { windowId: 'w', title: 'W' }],
    ]);
  });

  it('ignores a kind with no handler and a kind that is not a drop kind', () => {
    const { app, deliver } = installProtocol();
    const got: unknown[] = [];
    app.onDrop({ files: (files) => got.push(files) });
    deliver({ type: 'yaar:drop', kind: 'text', text: 'hi' });
    deliver({ type: 'yaar:drop', kind: 'toString' });
    expect(got).toEqual([]);
  });

  it('contains a handler that throws or rejects', async () => {
    const { app, deliver } = installProtocol();
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args[0]);
    try {
      app.onDrop({
        files: () => {
          throw new Error('boom');
        },
      });
      expect(() => deliver({ type: 'yaar:drop', kind: 'files', files: [] })).not.toThrow();
      app.onDrop({ files: () => Promise.reject(new Error('later')) });
      deliver({ type: 'yaar:drop', kind: 'files', files: [] });
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      console.error = original;
    }
    expect(errors).toHaveLength(2);
  });
});

interface FakeDragEvent {
  defaultPrevented: boolean;
  target: unknown;
  dataTransfer: { types: string[]; files: unknown[]; dropEffect?: string };
  preventDefault(): void;
}

function dragEvent(
  opts: { types?: string[]; files?: unknown[]; target?: unknown; prevented?: boolean } = {},
) {
  const e: FakeDragEvent = {
    defaultPrevented: !!opts.prevented,
    target: opts.target ?? { tagName: 'DIV' },
    dataTransfer: { types: opts.types ?? ['Files'], files: opts.files ?? ['file-a'] },
    preventDefault() {
      e.defaultPrevented = true;
    },
  };
  return e;
}

function installContextmenu() {
  const posted: Posted[] = [];
  const win = listenerBag();
  const doc = listenerBag();
  const window = {
    __yaarContextMenuInstalled: false,
    parent: { postMessage: (msg: Posted) => posted.push(msg) },
    addEventListener: win.addEventListener,
  } as Record<string, unknown>;
  const document = { addEventListener: doc.addEventListener };

  new Function('window', 'document', IFRAME_CONTEXTMENU_SCRIPT)(window, document);
  return { posted, win, doc };
}

describe('content-area file drops', () => {
  it('claims an unhandled OS file drop and forwards the files to the desktop', () => {
    const { posted, win } = installContextmenu();
    const over = dragEvent();
    win.fire('dragover', over);
    expect(over.defaultPrevented).toBe(true);
    expect(over.dataTransfer.dropEffect).toBe('copy');

    const drop = dragEvent({ files: ['a', 'b'] });
    win.fire('drop', drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(posted).toEqual([{ type: 'yaar:file-drop', files: ['a', 'b'] }]);
  });

  it("leaves a drop the app's own listener handled alone", () => {
    const { posted, win } = installContextmenu();
    win.fire('drop', dragEvent({ prevented: true }));
    expect(posted).toEqual([]);
  });

  it('leaves text drags to the browser', () => {
    const { posted, win } = installContextmenu();
    const over = dragEvent({ types: ['text/plain'] });
    win.fire('dragover', over);
    win.fire('drop', dragEvent({ types: ['text/plain'] }));
    expect(over.defaultPrevented).toBe(false);
    expect(posted).toEqual([]);
  });

  it('leaves a drop on a file input native', () => {
    const { posted, win } = installContextmenu();
    const drop = dragEvent({ target: { tagName: 'INPUT', type: 'file' } });
    win.fire('drop', drop);
    expect(drop.defaultPrevented).toBe(false);
    expect(posted).toEqual([]);
  });

  it("ignores a drag that started in the app's own document", () => {
    const { posted, win, doc } = installContextmenu();
    doc.fire('dragstart', {});
    win.fire('drop', dragEvent());
    expect(posted).toEqual([]);
    doc.fire('dragend', {});
    win.fire('drop', dragEvent());
    expect(posted).toHaveLength(1);
  });
});
