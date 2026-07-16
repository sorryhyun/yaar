/**
 * Session types for multi-client session support.
 */

import type { OSAction, SessionId } from '@yaar/shared';
import { genId } from '../lib/ids.js';

// Re-export from shared for backward compatibility
export type { SessionId } from '@yaar/shared';

/** Snapshot of current session state for new connections. */
export interface SessionSnapshot {
  actions: OSAction[];
}

/** Generate a unique session ID. */
export function generateSessionId(): SessionId {
  return genId('ses', 7);
}

let lastEpoch = 0;

/**
 * Stamp a session incarnation.
 *
 * A session id survives eviction and process restarts, so it cannot tell a client whether
 * the session behind it is the one it was talking to. The epoch can: it is minted per
 * LiveSession instance and never reused. Wall-clock based so it also increases across a
 * server restart, but forced upward when the clock repeats, so two incarnations created in
 * the same millisecond still get distinct epochs.
 */
export function nextSessionEpoch(): number {
  const now = Date.now();
  lastEpoch = now > lastEpoch ? now : lastEpoch + 1;
  return lastEpoch;
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
