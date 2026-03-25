/**
 * Tests for handleAppProtocolRequest — forwards App Protocol requests
 * from the server to the target iframe via postMessage, collects responses,
 * and pushes them into the store.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { handleAppProtocolRequest, useDesktopStore } from '@/store';
import { toWindowKey } from '@/store/helpers';
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
    pendingAppProtocolResponses: [],
  });
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

describe('handleAppProtocolRequest', () => {
  let originalSetTimeout: typeof globalThis.setTimeout;

  beforeEach(() => {
    resetStore();
    originalSetTimeout = globalThis.setTimeout;
    // Clean up any leftover DOM nodes from prior tests
    document.body.innerHTML = '';
  });

  afterEach(() => {
    globalThis.setTimeout = originalSetTimeout;
    document.body.innerHTML = '';
  });

  it('pushes an error response when the window DOM element is missing', () => {
    const request: AppProtocolRequest = { kind: 'manifest' };

    handleAppProtocolRequest('req-missing', 'nonexistent-window', request);

    const responses = useDesktopStore.getState().pendingAppProtocolResponses;
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      requestId: 'req-missing',
      windowId: 'nonexistent-window',
      response: { kind: 'manifest', error: 'Window element not found' },
    });
  });

  it('pushes an error response when the window element has no iframe', () => {
    const windowId = 'win-no-iframe';
    const key = toWindowKey(MONITOR_ID, windowId);

    // Create DOM element without an iframe
    const container = document.createElement('div');
    container.setAttribute('data-window-id', key);
    document.body.appendChild(container);

    const request: AppProtocolRequest = { kind: 'query', stateKey: 'items' };

    handleAppProtocolRequest('req-no-iframe', windowId, request);

    const responses = useDesktopStore.getState().pendingAppProtocolResponses;
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      requestId: 'req-no-iframe',
      windowId,
      response: { kind: 'query', error: 'No iframe found in window' },
    });
  });

  it('posts a message to the iframe and collects the response on successful roundtrip', () => {
    const windowId = 'win-app';
    const { iframe } = createWindowElement(windowId);

    // Mock postMessage on the iframe's contentWindow
    const postMessageSpy = mock(() => {});
    Object.defineProperty(iframe, 'contentWindow', {
      value: { postMessage: postMessageSpy },
      writable: false,
    });

    const request: AppProtocolRequest = { kind: 'manifest' };
    handleAppProtocolRequest('req-1', windowId, request);

    // Verify postMessage was called with the right payload
    expect(postMessageSpy).toHaveBeenCalledWith(
      { type: 'yaar:app-manifest-request', requestId: 'req-1' },
      '*',
    );

    // Simulate the iframe responding via a MessageEvent on the window
    const responseEvent = new MessageEvent('message', {
      data: {
        type: 'yaar:app-manifest-response',
        requestId: 'req-1',
        manifest: { appId: 'test', name: 'Test App', state: {}, commands: {} },
      },
    });
    // happy-dom's MessageEvent constructor doesn't accept source in init dict,
    // so we set it via defineProperty
    Object.defineProperty(responseEvent, 'source', {
      value: iframe.contentWindow,
      writable: false,
    });
    window.dispatchEvent(responseEvent);

    const responses = useDesktopStore.getState().pendingAppProtocolResponses;
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      requestId: 'req-1',
      windowId,
      response: {
        kind: 'manifest',
        manifest: { appId: 'test', name: 'Test App', state: {}, commands: {} },
      },
    });
  });

  it('pushes a timeout error when the iframe does not respond within 5000ms', () => {
    const windowId = 'win-slow';
    const { iframe } = createWindowElement(windowId);

    const postMessageSpy = mock(() => {});
    Object.defineProperty(iframe, 'contentWindow', {
      value: { postMessage: postMessageSpy },
      writable: false,
    });

    // Override setTimeout to invoke the callback immediately (simulates timer expiry)
    globalThis.setTimeout = ((fn: () => void, _delay?: number) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof globalThis.setTimeout;

    const request: AppProtocolRequest = {
      kind: 'command',
      command: 'doSomething',
      params: { x: 1 },
    };
    handleAppProtocolRequest('req-timeout', windowId, request);

    // Verify postMessage was called
    expect(postMessageSpy).toHaveBeenCalledTimes(1);

    const responses = useDesktopStore.getState().pendingAppProtocolResponses;
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      requestId: 'req-timeout',
      windowId,
      response: {
        kind: 'command',
        error: 'Timeout waiting for app response',
      },
    });
  });
});
