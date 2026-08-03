import { describe, it, expect, mock } from 'bun:test';
import {
  createWsManager,
  sendEvent,
  shouldReconnect,
  openSocket,
  markAttached,
  retryNow,
  reconnectDelay,
  RECONNECT_BASE_DELAY,
  RECONNECT_MAX_DELAY,
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
    setConnectionError: mock(() => {}),
    setSession: mock(() => {}),
    setAttachment: mock(() => {}),
    checkForPreviousSession: mock(() => {}),
    setMonitors: mock(() => {}),
    refreshStaleIframeTokens: mock(() => {}),
    addDebugEntry: mock(() => {}),
    setAgentActive: mock(() => {}),
    clearAgent: mock(() => {}),
    registerWindowAgent: mock(() => {}),
    updateWindowAgentStatus: mock(() => {}),
    updateCliStreaming: mock(() => {}),
    appendCliStreaming: mock(() => {}),
    finalizeCliStreaming: mock(() => {}),
    addCliEntry: mock(() => {}),
    handleAppProtocolRequest: mock(() => {}),
    handleVerbSubscriptionUpdate: mock(() => {}),
    handleStreamFrame: mock(() => {}),
    restoreCliHistory: mock(() => {}),
    acceptMessage: mock(() => {}),
    queueMessage: mock(() => {}),
    failMessage: mock(() => {}),
    settleOutbox: mock(() => {}),
    clearAllMessageStatuses: mock(() => {}),
    applySnapshot: mock(() => {}),
    flushPending: mock(() => {}),
    resync: mock(() => {}),
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
    expect(shouldReconnect(1006, false)).toBe(true);
    expect(shouldReconnect(1000, false)).toBe(false);
    // An explicit disconnect() stops it; a dirty close never does, however many
    // attempts have already gone by — retries are indefinite by design.
    expect(shouldReconnect(1006, true)).toBe(false);
  });

  it('backs off exponentially, with jitter, up to a ceiling', () => {
    const noJitter = () => 0.5;
    expect(reconnectDelay(0, noJitter)).toBe(RECONNECT_BASE_DELAY);
    expect(reconnectDelay(1, noJitter)).toBe(RECONNECT_BASE_DELAY * 2);
    expect(reconnectDelay(4, noJitter)).toBe(RECONNECT_BASE_DELAY * 16);
    // Ceiling, and it stays there forever rather than growing unboundedly.
    expect(reconnectDelay(20, noJitter)).toBe(RECONNECT_MAX_DELAY);

    // Jitter spreads ±25% so tabs that lost the same server don't return in lockstep.
    expect(reconnectDelay(3, () => 0)).toBe(RECONNECT_BASE_DELAY * 8 * 0.75);
    expect(reconnectDelay(3, () => 1)).toBe(RECONNECT_BASE_DELAY * 8 * 1.25);
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

  it('keeps retrying past 15s of an unavailable server, then recovers', () => {
    const wsManager = createWsManager();
    const handlers = createSocketHandlers();
    let scheduledReconnects = 0;
    let simulatedElapsedMs = 0;

    // A server that accepts a socket and immediately drops it, never sending
    // SESSION_ATTACHED — transport open alone must not refill the retry budget.
    // The old policy gave up after 5 fixed 3s attempts, i.e. at the 15s mark;
    // keep failing well past that and the retries must still be scheduled.
    for (let i = 0; i < 12; i++) {
      const fake = createFakeSocket();
      expect(openSocket(wsManager, () => asSocket(fake), handlers)).not.toBeNull();

      fake.readyState = WebSocket.OPEN;
      fake.onopen?.(new Event('open'));
      fake.readyState = WebSocket.CLOSED;
      fake.onclose?.(closeEvent(1006));

      expect(wsManager.reconnectTimeout).not.toBeNull();
      scheduledReconnects++;
      simulatedElapsedMs += reconnectDelay(i, () => 0.5);
      clearTimeout(wsManager.reconnectTimeout!);
      wsManager.reconnectTimeout = null;
    }

    expect(scheduledReconnects).toBe(12);
    expect(wsManager.reconnectAttempts).toBe(12);
    expect(simulatedElapsedMs).toBeGreaterThan(15_000);

    // The server comes back: the next socket attaches, and the budget resets so a
    // later blip starts from a fast retry rather than the 30s ceiling.
    const good = createFakeSocket();
    expect(openSocket(wsManager, () => asSocket(good), handlers)).not.toBeNull();
    good.readyState = WebSocket.OPEN;
    good.onopen?.(new Event('open'));
    markAttached(wsManager);

    expect(wsManager.getSnapshot()).toBe(true);
    expect(wsManager.reconnectAttempts).toBe(0);
    expect(wsManager.nextRetryAt).toBeNull();
  });

  it('retryNow cancels the pending backoff and reconnects immediately', () => {
    const wsManager = createWsManager();
    const handlers = createSocketHandlers();
    const fake = createFakeSocket();
    openSocket(wsManager, () => asSocket(fake), handlers);
    fake.readyState = WebSocket.CLOSED;
    fake.onclose?.(closeEvent(1006));

    expect(wsManager.reconnectTimeout).not.toBeNull();
    wsManager.reconnectAttempts = 9; // deep into the backoff

    const reconnect = mock(() => {});
    retryNow(wsManager, reconnect);

    expect(reconnect).toHaveBeenCalledOnce();
    expect(wsManager.reconnectTimeout).toBeNull();
    expect(wsManager.nextRetryAt).toBeNull();
    expect(wsManager.reconnectAttempts).toBe(0);
    expect(wsManager.stopped).toBe(false);
  });

  it('resets the backoff only once the session attaches', () => {
    const wsManager = createWsManager();
    wsManager.reconnectAttempts = 4;
    wsManager.nextRetryAt = Date.now() + 16_000;

    markAttached(wsManager);

    // The next drop retries fast again instead of inheriting a deep backoff.
    expect(wsManager.reconnectAttempts).toBe(0);
    expect(wsManager.nextRetryAt).toBeNull();
    expect(shouldReconnect(1006, wsManager.stopped)).toBe(true);
  });

  it('reports connected only once the socket is bound to a session', () => {
    const wsManager = createWsManager();
    const fake = createFakeSocket();
    openSocket(wsManager, () => asSocket(fake), createSocketHandlers());

    // Transport is up, but the server has not said which session this socket carries.
    fake.readyState = WebSocket.OPEN;
    fake.onopen?.(new Event('open'));
    expect(wsManager.getSnapshot()).toBe(false);

    markAttached(wsManager);
    expect(wsManager.getSnapshot()).toBe(true);

    // The socket drops: attachment goes with it, and a replacement socket starts unattached.
    fake.readyState = WebSocket.CLOSED;
    fake.onclose?.(closeEvent(1006));
    expect(wsManager.attached).toBe(false);
    if (wsManager.reconnectTimeout !== null) clearTimeout(wsManager.reconnectTimeout);

    const next = createFakeSocket();
    openSocket(wsManager, () => asSocket(next), createSocketHandlers());
    next.readyState = WebSocket.OPEN;
    next.onopen?.(new Event('open'));
    expect(wsManager.getSnapshot()).toBe(false);
  });
});

describe('server event dispatcher', () => {
  it('records the session incarnation the join bound us to', () => {
    const handlers = createHandlers();

    dispatchServerEvent(
      {
        type: 'SESSION_ATTACHED',
        sessionId: 's1',
        sessionEpoch: 42,
        connectionId: 'conn-1',
        recoveryMode: 'attached',
        provider: 'claude',
        logSessionId: '2026-07-13_10-00-00',
      },
      handlers,
    );

    expect(handlers.setAttachment).toHaveBeenCalledWith({
      sessionId: 's1',
      sessionEpoch: 42,
      connectionId: 'conn-1',
      recoveryMode: 'attached',
      provider: 'claude',
    });
    // The history lookup is keyed by the transcript on disk, not the hub id.
    expect(handlers.checkForPreviousSession).toHaveBeenCalledWith('2026-07-13_10-00-00');
  });

  it('reconciles a replacement session instead of passing it off as a rejoin', () => {
    const handlers = createHandlers();

    dispatchServerEvent(
      {
        type: 'SESSION_ATTACHED',
        sessionId: 's1',
        sessionEpoch: 43,
        connectionId: 'conn-2',
        recoveryMode: 'replaced',
      },
      handlers,
    );

    expect(handlers.setAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ recoveryMode: 'replaced', sessionEpoch: 43 }),
    );
    // The tokens our iframes hold were minted by a process that is gone — every verb call
    // they make now answers 403. A replacement is exactly when they must be minted again.
    expect(handlers.refreshStaleIframeTokens).toHaveBeenCalledWith('s1');
    // This used to be a console.warn saying local state "may be stale" — an admission, not
    // a fix. Now the client says what it did while it was away and asks what is really
    // there, in that order: a snapshot built before the flush lands would report the user's
    // own buffered window as one that does not exist.
    expect(handlers.flushPending).toHaveBeenCalled();
    expect(handlers.resync).toHaveBeenCalled();
    expect(handlers.flushPending.mock.invocationCallOrder[0]).toBeLessThan(
      handlers.resync.mock.invocationCallOrder[0],
    );
  });

  it('leaves iframe tokens alone when the join is a real rejoin', () => {
    const handlers = createHandlers();

    dispatchServerEvent(
      {
        type: 'SESSION_ATTACHED',
        sessionId: 's1',
        sessionEpoch: 42,
        connectionId: 'conn-3',
        recoveryMode: 'attached',
      },
      handlers,
    );

    expect(handlers.refreshStaleIframeTokens).not.toHaveBeenCalled();
  });

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

  it('tails a running tool output by appending each chunk in order', () => {
    const handlers = createHandlers();

    for (const message of ['compiling\n', 'linking\n']) {
      dispatchServerEvent(
        { type: 'TOOL_PROGRESS', toolName: 'command', status: 'output', message, agentId: 'a3' },
        handlers,
      );
    }

    expect(handlers.appendCliStreaming).toHaveBeenCalledTimes(2);
    expect(handlers.appendCliStreaming).toHaveBeenNthCalledWith(
      1,
      'a3',
      'compiling\n',
      'tool',
      undefined,
    );
    expect(handlers.appendCliStreaming).toHaveBeenNthCalledWith(
      2,
      'a3',
      'linking\n',
      'tool',
      undefined,
    );
    // A tail is not a phase change: it must not flush the live block or restate
    // what the agent is doing — `running` already said "Running: command".
    expect(handlers.finalizeCliStreaming).not.toHaveBeenCalled();
    expect(handlers.setAgentActive).not.toHaveBeenCalled();
    // And it must not reach the debug panel, which one chunk per line would bury.
    expect(handlers.addDebugEntry).not.toHaveBeenCalled();
  });

  it('does not let an agent error report the connection as down', () => {
    const handlers = createHandlers();

    dispatchServerEvent(
      {
        type: 'ERROR',
        error: 'Failed to create agent for app devtools',
        agentId: 'app-devtools-m0',
        monitorId: '0',
      },
      handlers,
    );

    // The socket is open and the monitor agent is still working. This used to call
    // setConnectionStatus('error', …), which the status bar renders as "Disconnected"
    // and which nothing on a live session ever clears.
    expect(handlers.setConnectionStatus).not.toHaveBeenCalled();
    expect(handlers.setConnectionError).toHaveBeenCalledWith(
      'Failed to create agent for app devtools',
    );
    expect(handlers.addCliEntry).toHaveBeenCalledWith({
      type: 'error',
      content: 'Failed to create agent for app devtools',
      monitorId: '0',
    });
  });

  it('still buries a message named by an error', () => {
    const handlers = createHandlers();

    dispatchServerEvent(
      { type: 'ERROR', error: 'Message dropped: the window closed.', messageId: 'm-9' },
      handlers,
    );

    expect(handlers.failMessage).toHaveBeenCalledWith('m-9', 'Message dropped: the window closed.');
    expect(handlers.settleOutbox).toHaveBeenCalledWith('m-9');
  });

  it('ignores an output event with no chunk', () => {
    const handlers = createHandlers();
    dispatchServerEvent(
      { type: 'TOOL_PROGRESS', toolName: 'command', status: 'output', agentId: 'a3' },
      handlers,
    );
    expect(handlers.appendCliStreaming).not.toHaveBeenCalled();
  });

  // An unscoped windowId leaves the store to pick a monitor, and its pick is *this tab's*
  // active one. On a two-monitor desktop that forks the registries — the server holding
  // "1/preview", the tab holding "0/preview" — and every later app-protocol call against
  // the window then resolves to no DOM element, permanently.
  it('carries the event monitor onto a window action that arrived unscoped', () => {
    const handlers = createHandlers();
    dispatchServerEvent(
      {
        type: 'ACTIONS',
        monitorId: '1',
        actions: [
          {
            type: 'window.create',
            windowId: 'devtools-preview-1',
            title: 'preview',
            bounds: { x: 0, y: 0, w: 640, h: 480 },
            content: { renderer: 'iframe', data: '/x.html' },
          },
        ],
      } as unknown as Parameters<typeof dispatchServerEvent>[0],
      handlers,
    );

    const [actions] = handlers.applyActions.mock.calls[0] as unknown as [
      Array<{ monitorId?: string }>,
    ];
    expect(actions[0].monitorId).toBe('1');
  });

  it('leaves an already-scoped window action alone', () => {
    const handlers = createHandlers();
    dispatchServerEvent(
      {
        type: 'ACTIONS',
        monitorId: '1',
        actions: [{ type: 'window.close', windowId: '0/notes' }],
      } as unknown as Parameters<typeof dispatchServerEvent>[0],
      handlers,
    );

    const [actions] = handlers.applyActions.mock.calls[0] as unknown as [
      Array<Record<string, unknown>>,
    ];
    // A handle already names its monitor; re-stamping it would let the event's monitor
    // contradict the id and there would be no way to tell which one won.
    expect(actions[0]).toEqual({ type: 'window.close', windowId: '0/notes' });
  });
});
