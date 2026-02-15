/**
 * Tests for handleAppProtocolRequest — forwards App Protocol requests
 * from the server to the target iframe via postMessage, collects responses,
 * and pushes them into the store.
 */
import { handleAppProtocolRequest, useDesktopStore } from '@/store/desktop';
import { toWindowKey } from '@/store/helpers';
import type { AppProtocolRequest } from '@yaar/shared';

const MONITOR_ID = 'monitor-0';

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
  beforeEach(() => {
    resetStore();
    vi.useFakeTimers();
    // Clean up any leftover DOM nodes from prior tests
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.useRealTimers();
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
    const postMessageSpy = vi.fn();
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
      source: iframe.contentWindow as Window,
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

    const postMessageSpy = vi.fn();
    Object.defineProperty(iframe, 'contentWindow', {
      value: { postMessage: postMessageSpy },
      writable: false,
    });

    const request: AppProtocolRequest = {
      kind: 'command',
      command: 'doSomething',
      params: { x: 1 },
    };
    handleAppProtocolRequest('req-timeout', windowId, request);

    // Verify postMessage was called
    expect(postMessageSpy).toHaveBeenCalledTimes(1);

    // No response arrives — no pending responses yet
    expect(useDesktopStore.getState().pendingAppProtocolResponses).toHaveLength(0);

    // Advance past the 5000ms timeout
    vi.advanceTimersByTime(5000);

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
