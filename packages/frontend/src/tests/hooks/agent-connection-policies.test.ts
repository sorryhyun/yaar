import { describe, it, expect, mock } from 'bun:test';
import {
  createWsManager,
  sendEvent,
  shouldReconnect,
  openSocket,
  markAttached,
  MAX_RECONNECT_ATTEMPTS,
} from '@/hooks/use-agent-connection/transport-manager';
import { dispatchServerEvent } from '@/hooks/use-agent-connection/server-event-dispatcher';

/** A socket whose readyState and callbacks the test drives by hand. */
interface FakeSocket {
  readyState: number;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
}

function createFakeSocket(): FakeSocket {
  return {
    readyState: WebSocket.CONNECTING,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
}

const asSocket = (fake: FakeSocket) => fake as unknown as WebSocket;

function closeEvent(code: number): CloseEvent {
  return { code } as CloseEvent;
}

function createSocketHandlers() {
  return {
    onOpen: mock(() => {}),
    onMessage: mock(() => {}),
    onClose: mock(() => {}),
    onError: mock(() => {}),
    reconnect: mock(() => {}),
  };
}

function createHandlers() {
  return {
    applyActions: mock(() => {}),
    setIsConnecting: mock(() => {}),
    setConnectionStatus: mock(() => {}),
    setSession: mock(() => {}),
    checkForPreviousSession: mock(() => {}),
    addDebugEntry: mock(() => {}),
    setAgentActive: mock(() => {}),
    clearAgent: mock(() => {}),
    registerWindowAgent: mock(() => {}),
    updateWindowAgentStatus: mock(() => {}),
    updateCliStreaming: mock(() => {}),
    finalizeCliStreaming: mock(() => {}),
    addCliEntry: mock(() => {}),
    handleAppProtocolRequest: mock(() => {}),
    handleVerbSubscriptionUpdate: mock(() => {}),
    restoreCliHistory: mock(() => {}),
    acceptMessage: mock(() => {}),
    queueMessage: mock(() => {}),
    clearAllMessageStatuses: mock(() => {}),
    incrementSubagentCount: mock(() => {}),
    decrementSubagentCount: mock(() => {}),
  };
}

describe('transport manager', () => {
  it('sends only when socket is open', () => {
    const wsManager = createWsManager();
    const send = mock(() => {});
    wsManager.ws = { readyState: WebSocket.OPEN, send } as unknown as WebSocket;

    const ok = sendEvent(wsManager, { type: 'INTERRUPT' });
    expect(ok).toBe(true);
    expect(send).toHaveBeenCalledOnce();

    wsManager.ws = { readyState: WebSocket.CLOSED, send } as unknown as WebSocket;
    expect(sendEvent(wsManager, { type: 'INTERRUPT' })).toBe(false);
  });

  it('computes reconnect eligibility', () => {
    expect(shouldReconnect(1006, 0)).toBe(true);
    expect(shouldReconnect(1000, 0)).toBe(false);
    expect(shouldReconnect(1006, 5)).toBe(false);
  });
});

describe('socket lifecycle', () => {
  it('refuses to open a second socket while one is open or connecting', () => {
    const wsManager = createWsManager();
    const createSocket = mock(() => asSocket(createFakeSocket()));

    wsManager.ws = asSocket({ ...createFakeSocket(), readyState: WebSocket.OPEN });
    expect(openSocket(wsManager, createSocket, createSocketHandlers())).toBeNull();

    wsManager.ws = asSocket({ ...createFakeSocket(), readyState: WebSocket.CONNECTING });
    expect(openSocket(wsManager, createSocket, createSocketHandlers())).toBeNull();

    expect(createSocket).not.toHaveBeenCalled();
  });

  it('ignores callbacks from a socket that is no longer the registered one', () => {
    const wsManager = createWsManager();
    const staleHandlers = createSocketHandlers();

    const stale = createFakeSocket();
    openSocket(wsManager, () => asSocket(stale), staleHandlers);

    // The stale socket dies without notifying us, and a new socket takes its place.
    wsManager.ws = null;
    const fresh = createFakeSocket();
    openSocket(wsManager, () => asSocket(fresh), createSocketHandlers());

    // The stale socket's close handshake finally lands.
    stale.onclose?.(closeEvent(1006));

    expect(wsManager.getSocket()).toBe(asSocket(fresh)); // not nulled out by the old socket
    expect(wsManager.reconnectTimeout).toBeNull(); // no reconnect over a live connection
    expect(wsManager.reconnectAttempts).toBe(0);
    expect(staleHandlers.onClose).not.toHaveBeenCalled();

    // Its other callbacks are inert too.
    stale.onmessage?.(new MessageEvent('message', { data: '{}' }));
    stale.onerror?.(new Event('error'));
    expect(staleHandlers.onMessage).not.toHaveBeenCalled();
    expect(staleHandlers.onError).not.toHaveBeenCalled();
  });

  it('exhausts the retry limit when sockets open and close without attaching', () => {
    const wsManager = createWsManager();
    const handlers = createSocketHandlers();
    let scheduledReconnects = 0;

    // A server that accepts a socket and immediately drops it, never sending
    // CONNECTION_STATUS — transport open alone must not refill the retry budget.
    for (let i = 0; i < MAX_RECONNECT_ATTEMPTS + 2; i++) {
      const fake = createFakeSocket();
      expect(openSocket(wsManager, () => asSocket(fake), handlers)).not.toBeNull();

      fake.readyState = WebSocket.OPEN;
      fake.onopen?.(new Event('open'));
      fake.readyState = WebSocket.CLOSED;
      fake.onclose?.(closeEvent(1006));

      if (wsManager.reconnectTimeout !== null) {
        scheduledReconnects++;
        clearTimeout(wsManager.reconnectTimeout);
        wsManager.reconnectTimeout = null;
      }
    }

    expect(wsManager.reconnectAttempts).toBe(MAX_RECONNECT_ATTEMPTS);
    expect(scheduledReconnects).toBe(MAX_RECONNECT_ATTEMPTS);
  });

  it('refills the retry budget only once the session attaches', () => {
    const wsManager = createWsManager();
    wsManager.reconnectAttempts = 4;

    markAttached(wsManager);

    expect(wsManager.reconnectAttempts).toBe(0);
    expect(shouldReconnect(1006, wsManager.reconnectAttempts)).toBe(true);
  });
});

describe('server event dispatcher', () => {
  it('dispatches connection and response events', () => {
    const handlers = createHandlers();

    dispatchServerEvent(
      { type: 'CONNECTION_STATUS', status: 'connected', provider: 'claude', sessionId: 's1' },
      handlers,
    );
    expect(handlers.setConnectionStatus).toHaveBeenCalledWith('connected', undefined);
    expect(handlers.setSession).toHaveBeenCalledWith('claude', 's1');

    dispatchServerEvent(
      { type: 'AGENT_RESPONSE', content: 'done', isComplete: true, agentId: 'a1' },
      handlers,
    );
    expect(handlers.clearAgent).toHaveBeenCalledWith('a1');
  });

  it('dispatches tool progress as active status updates', () => {
    const handlers = createHandlers();
    dispatchServerEvent(
      { type: 'TOOL_PROGRESS', toolName: 'search', status: 'running', agentId: 'a2' },
      handlers,
    );
    expect(handlers.setAgentActive).toHaveBeenCalledWith('a2', 'Running: search');

    dispatchServerEvent(
      { type: 'TOOL_PROGRESS', toolName: 'search', status: 'complete', agentId: 'a2' },
      handlers,
    );
    expect(handlers.setAgentActive).toHaveBeenCalledWith('a2', 'Thinking...');
  });
});
