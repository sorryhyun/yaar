/**
 * SessionEmitterBridge — everything a `LiveSession` hears from the process-global
 * `actionEmitter`, attached in one place and detached in one place.
 *
 * The emitter is a singleton and its channels carry no session, so every LiveSession
 * hears every emit and filters for its own (see `emitter-channels.ts`). That makes the
 * listeners a leak with a long fuse: a session that attaches four and removes three keeps
 * receiving — and re-broadcasting — traffic for a session that is gone, forever, since
 * nothing else holds a reference that would let anyone notice. Setup and teardown live in
 * the same object here precisely so they cannot drift apart.
 */

import type { ServerEvent } from '@yaar/shared';
import { actionEmitter } from './action-emitter.js';
import type {
  ActionEvent,
  AppProtocolRequestData,
  BridgeEvent,
  SessionScopedChannel,
  SessionScopedEvent,
} from './emitter-channels.js';
import type { SessionId } from './types.js';

/**
 * The session-scoped channels whose events a LiveSession forwards to its connections
 * as-is. Each carries a `SessionScopedEvent`, which is what makes one filter-and-forward
 * handler enough for all of them.
 */
const FORWARDED_SESSION_CHANNELS: readonly SessionScopedChannel[] = [
  'approval-request',
  'user-prompt',
  // Actions the server sends on its own behalf, outside any agent turn — a dialog
  // whose deadline passed being taken off the screen. There is no monitor context
  // on a timer callback, and a dialog is session-scoped anyway.
  'session-action',
  'verb-subscription',
  'desktop-shortcut',
  'browser-action',
];

/**
 * Subscribe to session-scoped emitter channels that filter by sessionId
 * and forward matching events to a broadcast function.
 *
 * The channels are constrained to those whose payload is a `SessionScopedEvent`
 * (see `emitter-channels.ts`), so a channel that carries some other envelope cannot be
 * listed here and silently never match — this handler reads `data.sessionId`, and on a
 * channel that has none, every event would be dropped without a word.
 *
 * Returns a cleanup function that removes all listeners at once.
 */
function subscribeSessionChannels(
  sessionId: SessionId,
  broadcast: (event: ServerEvent) => void,
  channels: readonly SessionScopedChannel[],
): () => void {
  const handler = (data: SessionScopedEvent) => {
    if (data.sessionId === sessionId) {
      broadcast(data.event);
    }
  };
  for (const ch of channels) {
    // Explicit type argument: inference from a union of channel names lands on `never`,
    // since the map's key parameter appears on both sides of the listener's lookup.
    actionEmitter.on<SessionScopedChannel>(ch, handler);
  }
  return () => {
    for (const ch of channels) {
      actionEmitter.off<SessionScopedChannel>(ch, handler);
    }
  };
}

/**
 * What the session does with each thing it hears. Pass closures, not unbound methods —
 * these are handed to the emitter as-is.
 */
export interface SessionEmitterHandlers {
  /** An OS Action from a tool: window-state tracking, budgets, subscriber wakeups. */
  onAction(event: ActionEvent): void;
  /** A tool asking an iframe app something, via the frontend. */
  onAppProtocolRequest(data: AppProtocolRequestData): void;
  /** The real browser reporting something nobody asked for. */
  onBridgeEvent(data: BridgeEvent): void;
  /** Forward a session-scoped event to this session's connections. */
  broadcast(event: ServerEvent): void;
}

export class SessionEmitterBridge {
  private teardown: (() => void)[] = [];

  constructor(sessionId: SessionId, handlers: SessionEmitterHandlers) {
    const { onAction, onAppProtocolRequest, onBridgeEvent, broadcast } = handlers;

    this.teardown.push(actionEmitter.onAction(onAction));

    actionEmitter.on('app-protocol', onAppProtocolRequest);
    this.teardown.push(() => actionEmitter.off('app-protocol', onAppProtocolRequest));

    actionEmitter.on('bridge-event', onBridgeEvent);
    this.teardown.push(() => actionEmitter.off('bridge-event', onBridgeEvent));

    this.teardown.push(subscribeSessionChannels(sessionId, broadcast, FORWARDED_SESSION_CHANNELS));
  }

  /** Remove every listener this bridge added. Idempotent — cleanup can be re-entered. */
  detach(): void {
    for (const off of this.teardown.splice(0)) off();
  }
}
