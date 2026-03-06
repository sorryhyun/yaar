/**
 * Session types for multi-client session support.
 */

import type { OSAction, SessionId } from '@yaar/shared';

// Re-export from shared for backward compatibility
export type { SessionId } from '@yaar/shared';

/** Snapshot of current session state for new connections. */
export interface SessionSnapshot {
  actions: OSAction[];
}

/** Generate a unique session ID. */
export function generateSessionId(): SessionId {
  return `ses-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Minimal WebSocket interface decoupling BroadcastCenter/LiveSession from the `ws` package.
 * Both Node `ws.WebSocket` and Bun's `ServerWebSocket` satisfy this interface.
 */
export interface YaarWebSocket {
  readonly readyState: number;
  send(data: string | ArrayBufferLike | Uint8Array): void;
}

/** WebSocket OPEN readyState constant (same value in both `ws` and Bun). */
export const WS_OPEN = 1;
