import type { ClientEvent } from '@/types';

export interface WsManager {
  ws: WebSocket | null;
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
    reconnectAttempts: 0,
    reconnectTimeout: null as number | null,
    listeners: new Set<() => void>(),

    getSnapshot() {
      return this.ws?.readyState === WebSocket.OPEN;
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
 * The session is attached (server sent CONNECTION_STATUS), so the retry budget resets.
 *
 * An open transport is not an attached session: a server that accepts a socket and
 * immediately drops it would otherwise reset the budget on every cycle and reconnect
 * forever. Only a completed handshake counts as progress.
 */
export function markAttached(wsManager: ReturnType<typeof createWsManager>): void {
  wsManager.reconnectAttempts = 0;
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
