/**
 * Tests for the App Protocol relay — the frontend leg between the server (WebSocket) and
 * an app's iframe (postMessage).
 *
 * Two contracts are load-bearing here, and both were once broken:
 *
 * 1. A reply goes **straight down the socket**, not into the Zustand pending queue. The
 *    server is sitting on a deadline for it; a buffered reply that lands after that
 *    deadline is a corpse, and the agent is told the app never answered.
 * 2. The relay **does not manufacture timeouts**. It used to run a clock of its own
 *    alongside the server's, and — being the leg exposed to Chrome's background-tab
 *    throttling — routinely fired it *late*, producing a reply that said "timeout" long
 *    after the server had already concluded the same thing on its own.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { handleAppProtocolRequest, resendAppProtocolReady, useDesktopStore } from '@/store';
import { toWindowKey } from '@/store/helpers';
import { wsManager } from '@/hooks/use-agent-connection/transport-manager';
import { drainPendingQueues } from '@/hooks/use-agent-connection/usePendingEventDrainer';
import type { AppProtocolRequest } from '@yaar/shared';

const MONITOR_ID = '0';

function resetStore() {
  useDesktopStore.setState({
    windows: {},
    zOrder: [],
    focusedWindowId: null,
    notifications: {},
    toasts: {},
    connectionStatus: 'disconnected',
    connectionError: null,
    activityLog: [],
    providerType: null,
    sessionId: null,
    activeMonitorId: MONITOR_ID,
    // *Every* outbound queue, not just this file's own. The store is a module singleton
    // shared by every test file in the Bun process, and `drainPendingQueues` empties all six
    // queues at once — so a stray item another file left in `pendingFeedback` becomes a frame
    // on this file's socket, and the drain test below reads it as its own. Reset what you
    // will be looking at.
    pendingFeedback: [],
    pendingAppProtocolResponses: [],
    pendingAppInteractions: [],
    pendingAppEvents: [],
    pendingInteractions: [],
    pendingGestureMessages: [],
  });
}

/** Put an open socket under the relay and record what it sends. */
function openSocket(): { sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  wsManager.ws = {
    readyState: WebSocket.OPEN,
    send: (data: string) => sent.push(JSON.parse(data)),
  } as unknown as WebSocket;
  return { sent };
}

/** Create a DOM element that looks like a rendered window containing an iframe. */
function createWindowElement(windowId: string): {
  container: HTMLDivElement;
  iframe: HTMLIFrameElement;
} {
  const key = toWindowKey(MONITOR_ID, windowId);
  const container = document.createElement('div');
  container.setAttribute('data-window-id', key);

  const iframe = document.createElement('iframe');
  container.appendChild(iframe);
  document.body.appendChild(container);

  return { container, iframe };
}

/** Give the iframe a contentWindow whose postMessage we can observe. */
function stubContentWindow(iframe: HTMLIFrameElement, postMessage = mock(() => {})) {
  Object.defineProperty(iframe, 'contentWindow', {
    value: { postMessage },
    writable: false,
  });
  return postMessage;
}

/** Dispatch a reply as if it came from the iframe. */
function replyFromIframe(iframe: HTMLIFrameElement, data: Record<string, unknown>) {
  const event = new window.MessageEvent('message', { data });
  // happy-dom's MessageEvent constructor doesn't accept `source` in the init dict.
  Object.defineProperty(event, 'source', { value: iframe.contentWindow, writable: false });
  window.dispatchEvent(event);
}

describe('handleAppProtocolRequest', () => {
  let originalSetTimeout: typeof globalThis.setTimeout;

  beforeEach(() => {
    resetStore();
    originalSetTimeout = globalThis.setTimeout;
    wsManager.ws = null;
    document.body.innerHTML = '';
  });

  afterEach(() => {
    globalThis.setTimeout = originalSetTimeout;
    wsManager.ws = null;
    document.body.innerHTML = '';
  });

  it('sends the reply straight down the socket, never through the pending queue', () => {
    const { sent } = openSocket();
    const windowId = 'win-app';
    const { iframe } = createWindowElement(windowId);
    const postMessage = stubContentWindow(iframe);

    const request: AppProtocolRequest = { kind: 'manifest' };
    handleAppProtocolRequest('req-1', windowId, request);

    expect(postMessage).toHaveBeenCalledWith(
      { type: 'yaar:app-manifest-request', requestId: 'req-1' },
      '*',
    );

    const manifest = { appId: 'test', name: 'Test App', state: {}, commands: {} };
    replyFromIframe(iframe, {
      type: 'yaar:app-manifest-response',
      requestId: 'req-1',
      manifest,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'APP_PROTOCOL_RESPONSE',
      requestId: 'req-1',
      windowId,
      response: { kind: 'manifest', manifest },
    });
    // The queue is the fallback for a dead socket, and this socket is alive.
    expect(useDesktopStore.getState().pendingAppProtocolResponses).toHaveLength(0);
  });

  it('falls back to the pending queue only when the socket is down', () => {
    const windowId = 'win-offline';
    const { iframe } = createWindowElement(windowId);
    stubContentWindow(iframe);

    handleAppProtocolRequest('req-offline', windowId, { kind: 'query', stateKey: 'items' });
    replyFromIframe(iframe, {
      type: 'yaar:app-query-response',
      requestId: 'req-offline',
      data: { items: [] },
    });

    const responses = useDesktopStore.getState().pendingAppProtocolResponses;
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      requestId: 'req-offline',
      windowId,
      response: { kind: 'query', data: { items: [] } },
    });
  });

  it('drains the queued reply when the socket comes back', () => {
    const windowId = 'win-reconnect';
    const { iframe } = createWindowElement(windowId);
    stubContentWindow(iframe);

    // Socket down: the reply has nowhere to go but the queue.
    handleAppProtocolRequest('req-drain', windowId, { kind: 'command', command: 'save' });
    replyFromIframe(iframe, {
      type: 'yaar:app-command-response',
      requestId: 'req-drain',
      result: 'saved',
    });
    expect(useDesktopStore.getState().pendingAppProtocolResponses).toHaveLength(1);

    // Socket back. The reconnect is not a store change — the queue filled while the socket
    // was down and has sat unchanged since — so nothing wakes the subscriber and the attach
    // handler must drain by hand. A queue that fills and never empties is not a fallback,
    // it is a leak that also loses the reply.
    const { sent } = openSocket();
    const send = (event: unknown) => {
      (wsManager.ws as WebSocket).send(JSON.stringify(event));
    };
    drainPendingQueues({ send: send as never, addCliEntry: (() => {}) as never });

    // Filtered to the frames this test is about: `drainPendingQueues` empties all six of the
    // store's outbound queues, and the other five are not this test's business.
    const replies = sent.filter((e) => e.type === 'APP_PROTOCOL_RESPONSE');
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      type: 'APP_PROTOCOL_RESPONSE',
      requestId: 'req-drain',
      windowId,
      response: { kind: 'command', result: 'saved' },
    });
    // Consumed, not copied: a drain that leaves the item behind re-sends it on every
    // subsequent reconnect, and the server answers each one with "unknown request".
    expect(useDesktopStore.getState().pendingAppProtocolResponses).toHaveLength(0);

    // The server has almost certainly given up by now — its deadline did not pause while the
    // socket was down. This reply is expected to land as a *late* one and be logged as such
    // (`resolveAppProtocolResponse`, server-side S7). That is the point: a late reply that is
    // reported beats a reply that is silently dropped, because only one of them tells you the
    // app was working.
  });

  it('sends app interactions on the invoke-or-steer channel', () => {
    const { sent } = openSocket();
    useDesktopStore.getState().addPendingAppInteraction({
      windowId: '0/notes',
      content: '{"event":"status_changed","status":"done"}',
    });

    const send = (event: unknown) => {
      (wsManager.ws as WebSocket).send(JSON.stringify(event));
    };
    drainPendingQueues({ send: send as never, addCliEntry: (() => {}) as never });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'APP_INTERACTION',
      windowId: '0/notes',
      content: '<app_interaction>{"event":"status_changed","status":"done"}</app_interaction>',
    });
  });

  it('reports a missing window element as an error, immediately', () => {
    const { sent } = openSocket();

    handleAppProtocolRequest('req-missing', 'nonexistent-window', { kind: 'manifest' });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'APP_PROTOCOL_RESPONSE',
      requestId: 'req-missing',
      windowId: 'nonexistent-window',
      response: { kind: 'manifest' },
    });
    const { error } = (sent[0] as { response: { error: string } }).response;
    expect(error).toStartWith('Window element not found');
    // The generic sentence alone could not tell a not-yet-mounted window from the
    // server and the desktop holding different keys for it — the diagnosis must name
    // the key that was actually looked up.
    expect(error).toContain('0/nonexistent-window');
  });

  it('reports a window with no iframe as an error, immediately', () => {
    const { sent } = openSocket();
    const windowId = 'win-no-iframe';
    const container = document.createElement('div');
    container.setAttribute('data-window-id', toWindowKey(MONITOR_ID, windowId));
    document.body.appendChild(container);

    handleAppProtocolRequest('req-no-iframe', windowId, { kind: 'query', stateKey: 'items' });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      response: { kind: 'query', error: 'No iframe found in window' },
    });
  });

  it('manufactures no response when the app stays silent — the server owns the deadline', () => {
    const { sent } = openSocket();
    const windowId = 'win-slow';
    const { iframe } = createWindowElement(windowId);
    stubContentWindow(iframe);

    // Fire every timer the moment it is set, i.e. simulate the relay's clock expiring.
    const delays: Array<number | undefined> = [];
    globalThis.setTimeout = ((fn: () => void, delay?: number) => {
      delays.push(delay);
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof globalThis.setTimeout;

    handleAppProtocolRequest('req-timeout', windowId, { kind: 'command', command: 'doSomething' });

    // The relay's timer only unhooks the listener. It says nothing to the server: a
    // "Timeout waiting for app response" invented here is a second, indistinguishable
    // verdict racing the server's own, and this one is the one that gets throttled.
    expect(sent).toHaveLength(0);
    expect(useDesktopStore.getState().pendingAppProtocolResponses).toHaveLength(0);
  });

  it('outlives the server deadline before unhooking, so a slow reply is never cut off', () => {
    const windowId = '0/test-window';
    const el = document.createElement('div');
    el.setAttribute('data-window-id', windowId);
    const iframe = document.createElement('iframe');
    el.appendChild(iframe);
    document.body.appendChild(el);
    useDesktopStore.setState({
      windows: { [windowId]: { id: windowId } as never },
      activeMonitorId: '0',
    });
    stubContentWindow(iframe);

    const delays: Array<number | undefined> = [];
    globalThis.setTimeout = ((_fn: () => void, delay?: number) => {
      delays.push(delay);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof globalThis.setTimeout;

    handleAppProtocolRequest(
      'req-slow',
      windowId,
      { kind: 'command', command: 'compile' },
      120_000,
    );

    // The server said 120s. We stop listening strictly *after* that, never before — a
    // relay that unhooks first turns a slow app into a silent one.
    expect(delays).toHaveLength(1);
    expect(delays[0]!).toBeGreaterThan(120_000);
  });
});

describe('resendAppProtocolReady', () => {
  // No initIframeMessageHandlers() here: store/desktop.ts calls it at module load, so the
  // `yaar:app-ready` handler is already on the router. Calling it again would register a
  // *second* handler (the router keys on function identity) and every registration would
  // be announced twice.

  beforeEach(() => {
    resetStore();
    wsManager.ws = null;
    document.body.innerHTML = '';
  });

  afterEach(() => {
    wsManager.ws = null;
    document.body.innerHTML = '';
  });

  /** Announce `yaar:app-ready` from a mounted iframe, as the injected SDK does at register(). */
  function announceReady(iframe: HTMLIFrameElement) {
    const event = new window.MessageEvent('message', { data: { type: 'yaar:app-ready' } });
    Object.defineProperty(event, 'source', { value: iframe.contentWindow, writable: false });
    window.dispatchEvent(event);
  }

  it('re-announces readiness for still-mounted apps, flagged as a re-announce', () => {
    const windowId = 'win-ready';
    const key = toWindowKey(MONITOR_ID, windowId);
    const { iframe } = createWindowElement(windowId);
    // The router resolves the source iframe by walking up to [data-window-id], so the
    // contentWindow must be the identity it matches on.
    const fakeWindow = { postMessage: mock(() => {}) };
    Object.defineProperty(iframe, 'contentWindow', { value: fakeWindow, writable: false });

    const { sent } = openSocket();
    announceReady(iframe);
    // The registration itself is announced (unflagged — the iframe really did just register).
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'APP_PROTOCOL_READY', windowId: key });
    expect(sent[0].reannounce).toBeUndefined();

    // Reattach: the server may have forgotten (restart), the iframe has not.
    resendAppProtocolReady();

    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({
      type: 'APP_PROTOCOL_READY',
      windowId: key,
      // Not a fresh registration: the iframe never remounted, so its commands must not be
      // replayed at it.
      reannounce: true,
    });
  });

  it('forwards noReplay from the ready message when it is a valid string array', () => {
    const windowId = 'win-noreplay';
    const key = toWindowKey(MONITOR_ID, windowId);
    const { iframe } = createWindowElement(windowId);
    Object.defineProperty(iframe, 'contentWindow', {
      value: { postMessage: mock(() => {}) },
      writable: false,
    });

    const { sent } = openSocket();
    const event = new window.MessageEvent('message', {
      data: { type: 'yaar:app-ready', noReplay: ['addMemo', 'sendInteraction'] },
    });
    Object.defineProperty(event, 'source', { value: iframe.contentWindow, writable: false });
    window.dispatchEvent(event);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'APP_PROTOCOL_READY',
      windowId: key,
      noReplay: ['addMemo', 'sendInteraction'],
    });
  });

  it('omits noReplay when the iframe sends nothing, and drops it if it is not an array of strings', () => {
    const bareWindowId = 'win-bare';
    const bareKey = toWindowKey(MONITOR_ID, bareWindowId);
    const { iframe: bareIframe } = createWindowElement(bareWindowId);
    Object.defineProperty(bareIframe, 'contentWindow', {
      value: { postMessage: mock(() => {}) },
      writable: false,
    });

    const { sent } = openSocket();
    announceReady(bareIframe);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'APP_PROTOCOL_READY', windowId: bareKey });
    expect(sent[0].noReplay).toBeUndefined();

    // Junk crossing the postMessage boundary — not an array of strings — must not be
    // forwarded to the server as if it were a legitimate command-name list.
    const junkWindowId = 'win-junk';
    const junkKey = toWindowKey(MONITOR_ID, junkWindowId);
    const { iframe: junkIframe } = createWindowElement(junkWindowId);
    Object.defineProperty(junkIframe, 'contentWindow', {
      value: { postMessage: mock(() => {}) },
      writable: false,
    });
    const junkEvent = new window.MessageEvent('message', {
      data: { type: 'yaar:app-ready', noReplay: { evil: true } },
    });
    Object.defineProperty(junkEvent, 'source', {
      value: junkIframe.contentWindow,
      writable: false,
    });
    window.dispatchEvent(junkEvent);

    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ type: 'APP_PROTOCOL_READY', windowId: junkKey });
    expect(sent[1].noReplay).toBeUndefined();
  });

  it('repeats the same noReplay list on resendAppProtocolReady', () => {
    const windowId = 'win-noreplay-resend';
    const key = toWindowKey(MONITOR_ID, windowId);
    const { iframe } = createWindowElement(windowId);
    Object.defineProperty(iframe, 'contentWindow', {
      value: { postMessage: mock(() => {}) },
      writable: false,
    });

    const { sent } = openSocket();
    const event = new window.MessageEvent('message', {
      data: { type: 'yaar:app-ready', noReplay: ['addMemo'] },
    });
    Object.defineProperty(event, 'source', { value: iframe.contentWindow, writable: false });
    window.dispatchEvent(event);
    expect(sent).toHaveLength(1);

    resendAppProtocolReady();

    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({
      type: 'APP_PROTOCOL_READY',
      windowId: key,
      reannounce: true,
      noReplay: ['addMemo'],
    });
  });

  it('says nothing for an app whose window is gone', () => {
    const windowId = 'win-closed';
    const { container, iframe } = createWindowElement(windowId);
    Object.defineProperty(iframe, 'contentWindow', {
      value: { postMessage: mock(() => {}) },
      writable: false,
    });

    const { sent } = openSocket();
    announceReady(iframe);
    expect(sent).toHaveLength(1);

    container.remove();
    resendAppProtocolReady();

    // We only vouch for iframes we can still see.
    expect(sent).toHaveLength(1);
  });
});
