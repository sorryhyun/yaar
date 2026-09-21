/**
 * iframeMessageRouter — the single `window` message listener every `yaar:*` postMessage
 * from a same-origin app iframe goes through. Covers the route table (only `yaar:*` types,
 * only to handlers registered for that exact type), `on()`'s subscribe/unsubscribe, and
 * source resolution (which window iframe a message came from, and its `toViewport`).
 *
 * happy-dom's real `postMessage` round trip does not preserve `MessageEvent.source` identity
 * against `iframe.contentWindow` (a happy-dom limitation, not something under test here), so
 * these dispatch a synthetic `message` event built from happy-dom's own `Event` class with
 * `data`/`source` defined directly — `handleMessage` only ever reads those two properties.
 */
import { describe, it, expect, afterEach } from 'bun:test';

import { iframeMessages } from '@/lib/iframeMessageRouter';

function fakeMessageEvent(data: unknown, source: unknown = null): Event {
  const ev = new window.Event('message');
  Object.defineProperty(ev, 'data', { value: data });
  Object.defineProperty(ev, 'source', { value: source });
  return ev;
}

function dispatch(data: unknown, source: unknown = null) {
  window.dispatchEvent(fakeMessageEvent(data, source));
}

/** A `[data-window-id]` ancestor with an iframe inside it, the shape resolveSource looks for. */
function mountWindowIframe(windowId: string): HTMLIFrameElement {
  const windowEl = document.createElement('div');
  windowEl.setAttribute('data-window-id', windowId);
  const iframe = document.createElement('iframe');
  windowEl.appendChild(iframe);
  document.body.appendChild(windowEl);
  return iframe;
}

const unsubs: Array<() => void> = [];
function on(type: Parameters<typeof iframeMessages.on>[0], handler: (ctx: unknown) => void) {
  const off = iframeMessages.on(type, handler as never);
  unsubs.push(off);
  return off;
}

afterEach(() => {
  while (unsubs.length) unsubs.pop()!();
  document.body.innerHTML = '';
});

describe('route table', () => {
  it('ignores messages with no type field', () => {
    let calls = 0;
    on('yaar:click', () => {
      calls += 1;
    });
    dispatch({ foo: 'bar' });
    expect(calls).toBe(0);
  });

  it('ignores messages whose type does not start with yaar:', () => {
    let calls = 0;
    on('yaar:click', () => {
      calls += 1;
    });
    dispatch({ type: 'webpackHMR' });
    expect(calls).toBe(0);
  });

  it('ignores messages whose type is not a string', () => {
    let calls = 0;
    on('yaar:click', () => {
      calls += 1;
    });
    dispatch({ type: 42 });
    expect(calls).toBe(0);
  });

  it('only invokes handlers registered for the matching type', () => {
    let clicks = 0;
    let keydowns = 0;
    on('yaar:click', () => {
      clicks += 1;
    });
    on('yaar:keydown', () => {
      keydowns += 1;
    });

    dispatch({ type: 'yaar:click' });

    expect(clicks).toBe(1);
    expect(keydowns).toBe(0);
  });

  it('invokes every handler registered for the same type', () => {
    let a = 0;
    let b = 0;
    on('yaar:app-ready', () => {
      a += 1;
    });
    on('yaar:app-ready', () => {
      b += 1;
    });

    dispatch({ type: 'yaar:app-ready' });

    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  it('does nothing when a type has no registered handlers (no crash on unknown yaar: type)', () => {
    expect(() => dispatch({ type: 'yaar:nothing-listens-for-this' })).not.toThrow();
  });

  it('passes the raw data through to the handler', () => {
    let received: unknown = null;
    on('yaar:app-interaction', (ctx) => {
      received = (ctx as { data: unknown }).data;
    });

    dispatch({ type: 'yaar:app-interaction', detail: 'hover' });

    expect(received).toEqual({ type: 'yaar:app-interaction', detail: 'hover' });
  });
});

describe('on() subscribe/unsubscribe', () => {
  it('stops receiving messages after calling the returned unsubscribe', () => {
    let calls = 0;
    const off = iframeMessages.on('yaar:click', () => {
      calls += 1;
    });

    dispatch({ type: 'yaar:click' });
    expect(calls).toBe(1);

    off();
    dispatch({ type: 'yaar:click' });
    expect(calls).toBe(1);
  });

  it('unsubscribing one handler leaves a sibling handler for the same type intact', () => {
    let a = 0;
    let b = 0;
    const offA = iframeMessages.on('yaar:click', () => {
      a += 1;
    });
    on('yaar:click', () => {
      b += 1;
    });

    offA();
    dispatch({ type: 'yaar:click' });

    expect(a).toBe(0);
    expect(b).toBe(1);
  });
});

describe('source resolution', () => {
  it('resolves the windowId of the [data-window-id] ancestor of the sending iframe', () => {
    const iframe = mountWindowIframe('win-1');
    let source: { windowId: string } | null = null;
    on('yaar:click', (ctx) => {
      source = (ctx as { source: { windowId: string } | null }).source;
    });

    dispatch({ type: 'yaar:click' }, iframe.contentWindow);

    expect(source).not.toBeNull();
    expect(source!.windowId).toBe('win-1');
  });

  it('resolves null when the message source matches no tracked iframe', () => {
    mountWindowIframe('win-1');
    let source: unknown = 'unset';
    on('yaar:click', (ctx) => {
      source = (ctx as { source: unknown }).source;
    });

    // A source object that is not any mounted iframe's contentWindow.
    dispatch({ type: 'yaar:click' }, {});

    expect(source).toBeNull();
  });

  it('resolves null when the message carries no source at all', () => {
    mountWindowIframe('win-1');
    let source: unknown = 'unset';
    on('yaar:click', (ctx) => {
      source = (ctx as { source: unknown }).source;
    });

    dispatch({ type: 'yaar:click' }, null);

    expect(source).toBeNull();
  });

  it('picks the right one of several windows on screen', () => {
    mountWindowIframe('win-1');
    const iframe2 = mountWindowIframe('win-2');
    let source: { windowId: string } | null = null;
    on('yaar:click', (ctx) => {
      source = (ctx as { source: { windowId: string } | null }).source;
    });

    dispatch({ type: 'yaar:click' }, iframe2.contentWindow);

    expect(source!.windowId).toBe('win-2');
  });

  it('toViewport translates iframe-local coordinates by the iframe rect origin', () => {
    const iframe = mountWindowIframe('win-1');
    let source: { toViewport: (x: number, y: number) => { x: number; y: number } } | null = null;
    on('yaar:click', (ctx) => {
      source = (
        ctx as {
          source: { toViewport: (x: number, y: number) => { x: number; y: number } } | null;
        }
      ).source;
    });

    dispatch({ type: 'yaar:click' }, iframe.contentWindow);

    expect(source).not.toBeNull();
    // happy-dom lays out nothing, so the iframe's rect is at the origin — this is exercising
    // the addition formula (rect.left + clientX, rect.top + clientY), not real layout.
    expect(source!.toViewport(10, 20)).toEqual({ x: 10, y: 20 });
  });

  it('an iframe with no [data-window-id] ancestor resolves no source', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    let source: unknown = 'unset';
    on('yaar:click', (ctx) => {
      source = (ctx as { source: unknown }).source;
    });

    dispatch({ type: 'yaar:click' }, iframe.contentWindow);

    expect(source).toBeNull();
  });
});
