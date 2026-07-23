/**
 * The table of client frames a session answers — one row per frame, and no rows for
 * anything else.
 *
 * `ClientEventRoutes` is **total**: every member of the `ClientEvent` union needs a row,
 * so a new frame type added in `@yaar/shared` is a compile error here rather than a frame
 * that is silently dropped at runtime. The runtime `if (!handler)` in `dispatch` is not
 * that check — it is for frames that are not a `ClientEvent` at all (a malformed or
 * newer-client body that got past parsing). That behavior is preserved deliberately.
 */

import type { ClientEvent } from '@yaar/shared';
import type { ConnectionId } from './broadcast-center.js';

export type ClientEventName = ClientEvent['type'];

export type ClientEventOf<K extends ClientEventName> = Extract<ClientEvent, { type: K }>;

/**
 * The return is `unknown`, not `void | Promise<void>`: a handler is free to be the one
 * expression that answers the frame (`this.pool?.interruptAll()`), and half of those
 * return something incidental. `dispatch` awaits the result, so a promise is waited on and
 * anything else is ignored — the union would only force a block around each one-liner.
 */
export type ClientEventHandler<K extends ClientEventName> = (
  event: ClientEventOf<K>,
  connectionId: ConnectionId,
) => unknown;

/** One handler per client frame. Total on purpose — see the module comment. */
export type ClientEventRoutes = {
  [K in ClientEventName]: ClientEventHandler<K>;
};

export class ClientEventRouter {
  constructor(private readonly routes: ClientEventRoutes) {}

  /**
   * Run the handler for this frame, if there is one. Awaited, so a handler that returns a
   * promise finishes before the caller considers the frame handled — the frames arrive in
   * order on one socket and some of them (a user message, a reset) depend on it.
   */
  async dispatch(event: ClientEvent, connectionId: ConnectionId): Promise<void> {
    // The lookup is safe per-key by construction (see `ClientEventRoutes`); the cast only
    // collapses the union of handlers the indexed access produces for a union key, which
    // TypeScript cannot call even though every member accepts the frame we hold.
    const handler = this.routes[event.type] as ClientEventHandler<ClientEventName> | undefined;
    if (!handler) return;
    await handler(event, connectionId);
  }
}
