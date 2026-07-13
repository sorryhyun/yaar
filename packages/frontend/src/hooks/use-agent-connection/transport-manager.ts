import type { ClientEvent } from '@/types';

export interface WsManager {
  ws: WebSocket | null;
  attached: boolean;
  reconnectAttempts: number;
  reconnectTimeout: number | null;
  listeners: Set<() => void>;
  getSnapshot: () => boolean;
  subscribe: (listener: () => void) => () => void;
  notify: () => void;
  getSocket: () => WebSocket | null;
}

export const RECONNECT_DELAY = 3000;
export const MAX_RECONNECT_ATTEMPTS = 5;

export function createWsManager() {
  const wsManager = {
    ws: null as WebSocket | null,
    /** Set once the server answers with SESSION_ATTACHED — see markAttached(). */
    attached: false,
    reconnectAttempts: 0,
    reconnectTimeout: null as number | null,
    listeners: new Set<() => void>(),

    /**
     * "Connected" means the socket is open *and* the server has bound it to a session.
     * A socket that opened but never attached carries no session: anything sent over it
     * reaches a server that does not yet know which conversation it belongs to.
     */
    getSnapshot() {
      return this.ws?.readyState === WebSocket.OPEN && this.attached;
    },

    subscribe(listener: () => void) {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    },

    notify() {
      this.listeners.forEach((l) => l());
    },

    getSocket() {
      return this.ws;
    },
  };

  return wsManager;
}

export function sendEvent(
  wsManager: ReturnType<typeof createWsManager>,
  event: ClientEvent,
): boolean {
  if (wsManager.ws?.readyState !== WebSocket.OPEN) {
    return false;
  }

  wsManager.ws.send(JSON.stringify(event));
  return true;
}

export function shouldReconnect(closeCode: number, reconnectAttempts: number): boolean {
  return closeCode !== 1000 && reconnectAttempts < MAX_RECONNECT_ATTEMPTS;
}

/**
 * The server answered the join with SESSION_ATTACHED: the socket now carries a session.
 *
 * This — not transport open — is what makes the connection usable and what refills the
 * retry budget. A server that accepts a socket and immediately drops it never gets here,
 * so it exhausts the budget instead of being retried forever.
 */
export function markAttached(wsManager: ReturnType<typeof createWsManager>): void {
  wsManager.attached = true;
  wsManager.reconnectAttempts = 0;
  wsManager.notify();
}

export interface SocketHandlers {
  onOpen: (socket: WebSocket) => void;
  onMessage: (event: MessageEvent) => void;
  onClose: (event: CloseEvent) => void;
  onError: () => void;
  reconnect: () => void;
}

/**
 * Open a socket and wire its callbacks to `wsManager`, unless one is already live.
 *
 * Every callback bails when it is not the currently registered socket. Callbacks from a
 * superseded socket can still fire after a newer one is registered (a close handshake is
 * asynchronous), and without this guard a late `onclose` nulls out `wsManager.ws` and
 * schedules a reconnect over a healthy connection.
 *
 * Returns the new socket, or null when an existing socket is already open/connecting.
 */
export function openSocket(
  wsManager: ReturnType<typeof createWsManager>,
  createSocket: () => WebSocket,
  handlers: SocketHandlers,
): WebSocket | null {
  if (
    wsManager.ws?.readyState === WebSocket.OPEN ||
    wsManager.ws?.readyState === WebSocket.CONNECTING
  ) {
    return null;
  }

  const socket = createSocket();
  wsManager.ws = socket;
  // A new socket has attached to nothing yet, whatever the old one had achieved.
  wsManager.attached = false;
  const isCurrent = () => wsManager.ws === socket;

  socket.onopen = () => {
    if (!isCurrent()) return;
    wsManager.notify();
    handlers.onOpen(socket);
  };

  socket.onmessage = (event) => {
    if (!isCurrent()) return;
    handlers.onMessage(event);
  };

  socket.onclose = (event) => {
    if (!isCurrent()) return;
    wsManager.ws = null;
    wsManager.attached = false;
    wsManager.notify();
    handlers.onClose(event);

    if (shouldReconnect(event.code, wsManager.reconnectAttempts)) {
      wsManager.reconnectAttempts++;
      wsManager.reconnectTimeout = setTimeout(
        handlers.reconnect,
        RECONNECT_DELAY,
      ) as unknown as number;
    }
  };

  socket.onerror = () => {
    if (!isCurrent()) return;
    handlers.onError();
  };

  return socket;
}

// Shared singleton used across all hooks in this module
export const wsManager = createWsManager();
