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
