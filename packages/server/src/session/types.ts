/**
 * Session types for multi-client session support.
 */

import type { SessionId } from '@yaar/shared';
import { genId } from '@yaar/lib/ids';

// Re-export from shared for backward compatibility
export type { SessionId } from '@yaar/shared';

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
 *
 * The queued-byte count and `close` are optional so a test fake can still satisfy this with
 * two members; a fake that omits them is simply never found to be over its send budget (see
 * `BroadcastCenter.deliver`).
 *
 * There are two spellings of the count because the two implementations disagree, and only
 * one of them is what this server's connections actually are: Bun's `ServerWebSocket` — the
 * concrete type `websocket/server.ts` hands to `BroadcastCenter.subscribe` — exposes the
 * **method** `getBufferedAmount()` and has no `bufferedAmount` property at all, so reading
 * the property is silently `undefined` there. `ws.WebSocket` and the browser/client
 * `WebSocket` expose the **property**. Declaring both keeps this interface honest about
 * satisfying either.
 */
export interface YaarWebSocket {
  readonly readyState: number;
  send(data: string | ArrayBufferLike | Uint8Array): void;
  /** Bun's `ServerWebSocket` spelling. */
  getBufferedAmount?(): number;
  /** The `ws` / client `WebSocket` spelling. */
  readonly bufferedAmount?: number;
  close?(code?: number, reason?: string): void;
}

/** WebSocket OPEN readyState constant (same value in both `ws` and Bun). */
export const WS_OPEN = 1;
