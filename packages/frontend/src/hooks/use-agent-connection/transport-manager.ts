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

export const WS_URL =
  import.meta.env.VITE_WS_URL ||
  (typeof window !== 'undefined'
    ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`
    : 'ws://localhost:8000/ws');

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
