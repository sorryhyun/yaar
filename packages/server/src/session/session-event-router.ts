/**
 * SessionEventRouter — one process-wide subscription per emitter channel, delivering each
 * event to the single session it names.
 *
 * This replaces a per-session bridge that attached nine listeners to the global
 * `actionEmitter` for every `LiveSession`. Two things were wrong with that, and only the
 * first is the obvious one:
 *
 * 1. **Listener count grew with session count.** Nine per session, on an `EventEmitter`
 *    whose default warning threshold is ten — eleven retained sessions in the WebSocket
 *    integration test was enough to print `MaxListenersExceededWarning` on every one of
 *    those channels. Raising the threshold would have silenced the symptom and kept the
 *    shape: N sessions still meant N callbacks invoked per emit, each of which had to
 *    re-derive that the event was not for it.
 *
 * 2. **Every session was told about every event, and had to be trusted to ignore it.**
 *    That is not a property a listener can be relied on to have — two of the channels
 *    carried no session at all to filter on, so their listeners could not have ignored
 *    anything even in principle (see `emitter-channels.ts`). Addressing was a convention
 *    each subscriber re-implemented, when it should have been the delivery mechanism.
 *
 * So delivery is a map lookup here, once, and a session's sink is only ever called with
 * events for that session. A session that has detached cannot be reached at all, rather
 * than being reached and expected to decline.
 *
 * The exception is deliberate and singular: `bridge-event`. There is one real browser and
 * its extension socket is process-global, so a frame from it carries no session and is
 * fanned out to every attached sink, each of which decides whether it has a window that
 * cares. Anything else that needs to be global must say so the same way — an explicitly
 * global envelope — rather than by leaving `sessionId` off and relying on the router to
 * broadcast by accident. There is no such path: an unaddressed event cannot be built.
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
 * The session-scoped channels whose events are forwarded to the session's connections
 * as-is. Each carries a `SessionScopedEvent`, which is what makes one lookup-and-forward
 * handler enough for all of them.
 *
 * The type constrains this to channels that actually carry a `SessionScopedEvent`, so a
 * channel with some other envelope cannot be listed here and then silently match nothing —
 * the handler reads `data.sessionId`, and on a channel that has none every event would be
 * dropped without a word.
 */
const FORWARDED_SESSION_CHANNELS: readonly SessionScopedChannel[] = [
  'approval-request',
  'user-prompt',
  // Actions the server sends on its own behalf, outside any agent turn — a dialog whose
  // deadline passed being taken off the screen. There is no monitor context on a timer
  // callback, and a dialog is session-scoped anyway.
  'session-action',
  'verb-subscription',
  'desktop-shortcut',
  'browser-action',
];

/** What a session does with each thing addressed to it. */
export interface SessionEventSink {
  /** An OS Action from a tool: window-state tracking, budgets, subscriber wakeups. */
  handleAction(event: ActionEvent): void;
  /** A tool asking one of this session's iframe apps something, via the frontend. */
  handleAppProtocolRequest(event: AppProtocolRequestData): void;
  /** The real browser reporting something nobody asked for. Global — see the note above. */
  handleBridgeEvent(event: BridgeEvent): void;
  /** Forward a session-scoped event to this session's connections. */
  broadcast(event: ServerEvent): void;
}

class SessionEventRouter {
  private readonly sinks = new Map<SessionId, SessionEventSink>();

  constructor() {
    // Installed once, at module load, and never removed: these are the process's
    // subscriptions, not any session's. A session comes and goes by appearing in and
    // disappearing from the map below.
    actionEmitter.on('action', (event) =>
      this.sinks.get(event.sessionId as SessionId)?.handleAction(event),
    );

    actionEmitter.on('app-protocol', (event) =>
      this.sinks.get(event.sessionId as SessionId)?.handleAppProtocolRequest(event),
    );

    // The one global channel. Every sink hears it; each decides for itself.
    actionEmitter.on('bridge-event', (event) => {
      for (const sink of this.sinks.values()) sink.handleBridgeEvent(event);
    });

    const forward = (data: SessionScopedEvent) =>
      this.sinks.get(data.sessionId as SessionId)?.broadcast(data.event);
    for (const channel of FORWARDED_SESSION_CHANNELS) {
      // Explicit type argument: inference from a union of channel names lands on `never`,
      // since the map's key parameter appears on both sides of the listener's lookup.
      actionEmitter.on<SessionScopedChannel>(channel, forward);
    }
  }

  /**
   * Register a session's sink. Replaces any sink already held for that id.
   *
   * Replacing rather than rejecting is intentional: a session id is reused across
   * reconnects, and the newest `LiveSession` holding it is the authority. A stale sink
   * that outlived its session would otherwise keep receiving.
   */
  attach(sessionId: SessionId, sink: SessionEventSink): void {
    this.sinks.set(sessionId, sink);
  }

  /**
   * Stop delivering to a session. Idempotent — cleanup can be re-entered.
   *
   * The sink is passed and checked for identity because a session id is not unique over
   * time: an evicted `LiveSession` and its replacement carry the same id (that is what
   * `epoch` exists to distinguish). Deleting by id alone would let a late `cleanup()` on
   * the *old* object silently unsubscribe the *new* one, and a live session that receives
   * nothing fails quietly — no error, no dropped-event log, just a desktop that stops
   * updating. Under the per-session bridge this could not happen: each object detached the
   * listeners it had added, which is the property being preserved here.
   */
  detach(sessionId: SessionId, sink: SessionEventSink): void {
    if (this.sinks.get(sessionId) === sink) this.sinks.delete(sessionId);
  }

  /** How many sessions are attached. For tests and diagnostics. */
  get size(): number {
    return this.sinks.size;
  }
}

/**
 * The process's router. One instance, created at module load, holding one subscription per
 * channel for the lifetime of the server.
 */
export const sessionEventRouter = new SessionEventRouter();
