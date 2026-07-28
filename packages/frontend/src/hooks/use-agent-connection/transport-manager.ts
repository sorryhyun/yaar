import type { ClientEvent } from '@/types';

export interface WsManager {
  ws: WebSocket | null;
  attached: boolean;
  stopped: boolean;
  reconnectAttempts: number;
  reconnectTimeout: number | null;
  /** Wall-clock ms at which the pending reconnect fires, for a countdown in the UI. */
  nextRetryAt: number | null;
  listeners: Set<() => void>;
  getSnapshot: () => boolean;
  subscribe: (listener: () => void) => () => void;
  notify: () => void;
  getSocket: () => WebSocket | null;
}

/** First retry lands quickly; the delay then doubles up to the ceiling. */
export const RECONNECT_BASE_DELAY = 1000;
/**
 * The ceiling the backoff settles at, and the rate at which retries then continue
 * indefinitely. Retrying forever at 30s is what lets a laptop that slept through a
 * server restart come back on its own; the old policy gave up after 5 tries in 15
 * seconds and left the tab permanently dead with no way back but a reload.
 */
export const RECONNECT_MAX_DELAY = 30000;

/**
 * Delay before retry number `attempts` (0-based), with jitter.
 *
 * Jitter is ±25%: without it every tab that lost the same server comes back at the
 * same instant and hammers it in lockstep as it starts.
 */
export function reconnectDelay(attempts: number, random: () => number = Math.random): number {
  const capped = Math.min(RECONNECT_BASE_DELAY * 2 ** attempts, RECONNECT_MAX_DELAY);
  return Math.round(capped * (0.75 + random() * 0.5));
}

export function createWsManager() {
  const wsManager = {
    ws: null as WebSocket | null,
    /** Set once the server answers with SESSION_ATTACHED — see markAttached(). */
    attached: false,
    /** The user (or unmount) asked us to stay down. Cleared by connect(). */
    stopped: false,
    reconnectAttempts: 0,
    reconnectTimeout: null as number | null,
    nextRetryAt: null as number | null,
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

/**
 * Whether a closed socket should be retried.
 *
 * Only two things stop it: a clean close (1000 — the server or `disconnect()` said
 * we are done) and an explicit `stopped`. There is no attempt ceiling: an
 * unreachable server is a condition that ends, and the backoff above is what keeps
 * an indefinite retry cheap.
 */
export function shouldReconnect(closeCode: number, stopped: boolean): boolean {
  return closeCode !== 1000 && !stopped;
}

/**
 * The server answered the join with SESSION_ATTACHED: the socket now carries a session.
 *
 * This — not transport open — is what makes the connection usable and what resets the
 * backoff. A server that accepts a socket and immediately drops it never gets here, so
 * it keeps backing off toward the ceiling rather than reconnecting in a tight loop.
 */
export function markAttached(wsManager: ReturnType<typeof createWsManager>): void {
  wsManager.attached = true;
  wsManager.reconnectAttempts = 0;
  wsManager.nextRetryAt = null;
  wsManager.notify();
}

/**
 * Cancel any pending retry and reconnect now — the "Retry" button's entry point.
 * Resets the backoff so a user-driven retry is immediate, not 30 seconds away.
 */
export function retryNow(
  wsManager: ReturnType<typeof createWsManager>,
  reconnect: () => void,
): void {
  if (wsManager.reconnectTimeout !== null) {
    clearTimeout(wsManager.reconnectTimeout);
    wsManager.reconnectTimeout = null;
  }
  wsManager.stopped = false;
  wsManager.reconnectAttempts = 0;
  wsManager.nextRetryAt = null;
  wsManager.notify();
  reconnect();
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

    if (shouldReconnect(event.code, wsManager.stopped)) {
      const delay = reconnectDelay(wsManager.reconnectAttempts);
      wsManager.reconnectAttempts++;
      wsManager.nextRetryAt = Date.now() + delay;
      wsManager.reconnectTimeout = setTimeout(() => {
        wsManager.reconnectTimeout = null;
        wsManager.nextRetryAt = null;
        handlers.reconnect();
      }, delay) as unknown as number;
      wsManager.notify();
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
