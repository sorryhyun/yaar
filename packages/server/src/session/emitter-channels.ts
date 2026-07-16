/**
 * The `actionEmitter`'s channels, and what each one carries.
 *
 * This map is the contract for every `actionEmitter.emit(...)` / `.on(...)` in the
 * server. `ActionEmitter` extends `EventEmitter<ActionEmitterChannels>`, so a channel
 * name that isn't listed here, or a payload that doesn't match the one listed, is a
 * compile error rather than an event that goes out and is never picked up.
 *
 * That failure mode is why this exists. This emitter is the only route to the frontend
 * for anything emitted outside an agent turn (HTTP routes, the verb proxy, expiry
 * timers — see the "Event Delivery Rule" in the package CLAUDE.md), and its delivery is
 * name-matched at runtime: a listener registered for `'verb-subscription'` simply never
 * hears an `emit('verb-subscriptions', ...)`. Nothing throws, nothing logs, and the
 * event is gone. The same goes for an envelope that is one field off from what the
 * listener destructures.
 *
 * There is deliberately **no `'error'` channel**. Node's `EventEmitter` throws on an
 * `'error'` event with no listener, which is the one channel here whose absence of a
 * listener would take the process down rather than drop a frame; if one is ever needed,
 * it needs a listener installed at construction, not just a row in this map.
 */

import type { AppProtocolRequest, OSAction, ServerEvent } from '@yaar/shared';

/**
 * An event addressed to one session, for `LiveSession` to broadcast.
 *
 * The `sessionId` is the whole point of the envelope: these channels are process-global,
 * so *every* live session hears every emit and each one keeps only what is addressed to
 * it (see `subscribeSessionChannels` in `live-session.ts`).
 */
export interface SessionScopedEvent {
  sessionId: string;
  event: ServerEvent;
}

/**
 * An OS Action emitted by a tool, with whatever identity the emitter could resolve.
 *
 * Unlike {@link SessionScopedEvent}, every field but the action is optional: an action
 * emitted from a timer or a warm-up has no agent, and one emitted outside a session has
 * no session. Consumers filter on what is present.
 */
export interface ActionEvent {
  action: OSAction;
  requestId?: string;
  sessionId?: string;
  agentId?: string;
  monitorId?: string;
}

/**
 * A request from a tool to an iframe app, relayed by the frontend.
 *
 * `timeoutMs` is the server's deadline, passed down so the frontend knows how long the
 * relay leg is allowed to take; it does not time the leg itself. See
 * `ActionEmitter.emitAppProtocolRequest`.
 *
 * Deliberately *not* named `AppProtocolRequestEvent`: `@yaar/shared` already exports that
 * name for the `ServerEvent` the frontend receives. This is the emitter-side envelope the
 * `LiveSession` listener turns into that event, and the two are a field apart.
 */
export interface AppProtocolRequestData {
  requestId: string;
  windowId: string;
  request: AppProtocolRequest;
  timeoutMs?: number;
}

/**
 * One iframe, in one session, saying "I am listening". Both halves are the key: the
 * window key alone names a *place* on a desktop, and two browsers looking at the same
 * YAAR have the same places. See `ActionEmitter.readyWindows`.
 */
export interface AppReadyEvent {
  sessionId: string;
  windowId: string;
}

/**
 * The YAAR Bridge extension speaking unprompted (a native dialog fired, a driven tab
 * navigated). It carries no session: the extension's socket is process-global and there
 * is exactly one real browser, so every `LiveSession` hears the frame and decides for
 * itself whether it has a window that cares.
 */
export interface BridgeEvent {
  channel: string;
  payload: unknown;
}

/**
 * Channel → listener arguments. Every channel carries exactly one payload object.
 */
export interface ActionEmitterChannels {
  /** An OS Action from a tool, picked up by `ToolActionBridge` and `LiveSession`. */
  action: [ActionEvent];
  /** An action the server sends on its own behalf, outside any agent turn. */
  'session-action': [SessionScopedEvent];
  /** A prompt shown to the user (`user.prompt.show`). */
  'user-prompt': [SessionScopedEvent];
  /** A permission dialog awaiting an answer. */
  'approval-request': [SessionScopedEvent];
  /** A change ping or stream frame for an iframe's verb subscription. */
  'verb-subscription': [SessionScopedEvent];
  /** A desktop shortcut added/removed from outside an agent turn. */
  'desktop-shortcut': [SessionScopedEvent];
  /** A browser window action emitted from an HTTP route. */
  'browser-action': [SessionScopedEvent];
  /** A tool asking an iframe app something, via the frontend. */
  'app-protocol': [AppProtocolRequestData];
  /** An iframe app registering with the App Protocol. */
  'app-ready': [AppReadyEvent];
  /** An unsolicited frame from the YAAR Bridge extension. */
  'bridge-event': [BridgeEvent];
}

/**
 * The channels whose payload is a {@link SessionScopedEvent} — i.e. those a
 * `LiveSession` can subscribe to with one filter-by-session handler. Derived from the
 * map rather than listed again, so a new session-scoped channel cannot be added to one
 * list and forgotten in the other.
 */
export type SessionScopedChannel = {
  [K in keyof ActionEmitterChannels]: ActionEmitterChannels[K] extends [SessionScopedEvent]
    ? K
    : never;
}[keyof ActionEmitterChannels];
