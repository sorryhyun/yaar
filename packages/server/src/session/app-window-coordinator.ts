/**
 * The session's half of the agent↔iframe conversation: which of this session's app windows
 * have a live document behind them, what reaches them, and what has to be re-sent when one
 * of them comes back.
 *
 * The request/response lifecycle itself is not here — a pending app-protocol request is
 * owned by the `ActionEmitter`'s pending store, keyed by request id, and settles wherever
 * the answer arrives. What *is* here is everything that depends on being a particular
 * session looking at a particular window: readiness, replay, and channel routing.
 *
 * Readiness is deliberately per (session, window key) and not per app. Two browsers showing
 * the same app on the same monitor share a window key, but each has its own document, and
 * only one of them has said it registered.
 */

import { ServerEventType, type ServerEvent } from '@yaar/shared';
import { BRIDGE_APP_ID } from '@yaar/shared/schemas';
import type { ClientEventType } from '@yaar/shared';
import type { ClientEventOf } from './client-event-router.js';
import type { AppProtocolRequestData } from './emitter-channels.js';
import type { SessionId } from './types.js';
import type { ConnectionId } from './broadcast-center.js';
import { connectionPresence } from './client-presence.js';
import type { WindowStateRegistry } from './window-state.js';
import { actionEmitter } from './action-emitter.js';
import { createLogger } from '../observability/log.js';

const log = createLogger('AppWindowCoordinator');

/** The pool operations this coordinator needs, narrowed so `ContextPool` stays out. */
export interface AppChannelTarget {
  notifyAppChannel(
    windowId: string,
    channel: string,
    payload: unknown,
    sourceAgentKey?: string,
    opts?: { wakeAgent?: boolean },
  ): void;
}

export interface AppWindowCoordinatorDeps {
  sessionId: SessionId;
  windowState: WindowStateRegistry;
  broadcast(event: ServerEvent): void;
  /** Deliver to one connection — an app protocol request has exactly one responder. */
  sendTo(connectionId: ConnectionId, event: ServerEvent): void;
  /** Whether that socket is still attached to this session. */
  hasConnection(connectionId: ConnectionId): boolean;
  /** Lazy — the pool does not exist until the first message that needs it. */
  getPool(): AppChannelTarget | null;
}

export class AppWindowCoordinator {
  /**
   * Per window key, the connections whose copy of the iframe has registered, oldest first.
   *
   * Every connected desktop mounts every window, so two tabs on one session means two
   * documents behind one key — and a request broadcast to both runs the handler in both.
   * For a query that is only wasted work; for a command it is the side effect twice (two
   * identical GitHub issues filed in the same second, from one `createIssue`). So a request
   * goes to exactly one of these, and this list is how the coordinator knows which ones
   * could take it.
   */
  private readonly readyConnections = new Map<string, ConnectionId[]>();

  /**
   * Requests sent to one connection and not yet known to be settled, so a responder that
   * disconnects mid-request can be replaced rather than waited out. Pruned lazily against
   * the pending store — an entry whose ask already settled is simply dropped.
   */
  private readonly inFlight = new Map<
    string,
    {
      connectionId: ConnectionId;
      windowKey: string;
      event: ServerEvent;
      request: AppProtocolRequestData['request'];
    }
  >();

  constructor(private readonly deps: AppWindowCoordinatorDeps) {}

  /**
   * A tool asking an iframe app something — relayed to ONE frontend that hosts it.
   *
   * Only when no connection has registered this window is it broadcast, which is the old
   * behaviour and the only honest fallback: the server cannot name a responder, and every
   * path that reaches here has already waited on readiness (`requireAppReady`), so this is
   * the rare case of a registration whose connection has since gone.
   */
  handleProtocolRequest(data: AppProtocolRequestData): void {
    const event: ServerEvent = {
      type: ServerEventType.APP_PROTOCOL_REQUEST,
      requestId: data.requestId,
      windowId: data.windowId,
      request: data.request,
      timeoutMs: data.timeoutMs,
    };
    const windowKey = this.resolveKey(data.windowId);
    const responder = this.pickResponder(windowKey);
    if (!responder) {
      this.deps.broadcast(event);
      return;
    }
    this.pruneSettled();
    this.inFlight.set(data.requestId, {
      connectionId: responder,
      windowKey,
      event,
      request: data.request,
    });
    this.deps.sendTo(responder, event);
  }

  /** Drop in-flight records whose ask has already been answered, expired, or cancelled. */
  private pruneSettled(): void {
    for (const requestId of this.inFlight.keys()) {
      if (!actionEmitter.isAppRequestPending(requestId)) this.inFlight.delete(requestId);
    }
  }

  /**
   * The responder for these requests is gone: hand each one that is still waiting to
   * another registered tab, so the agent gets an answer instead of a timeout.
   *
   * Except a command the app declared `replay: 'never'`. The tab that disconnected may
   * well have run it and lost only the reply — re-sending then is the very duplicate this
   * coordinator exists to prevent. That one is left to its deadline: a timeout the agent
   * can check on is recoverable, a second GitHub issue is not.
   */
  private reassignFrom(connectionId: ConnectionId): void {
    for (const [requestId, flight] of this.inFlight) {
      if (flight.connectionId !== connectionId) continue;
      if (!actionEmitter.isAppRequestPending(requestId)) {
        this.inFlight.delete(requestId);
        continue;
      }
      const oneShot =
        flight.request.kind === 'command' &&
        this.deps.windowState.getNoReplayCommands(flight.windowKey).has(flight.request.command);
      const next = oneShot ? null : this.pickResponder(flight.windowKey);
      if (!next) {
        log.info('responder disconnected mid-request; not re-sent', {
          sessionId: this.deps.sessionId,
          requestId,
          windowId: flight.windowKey,
          reason: oneShot ? 'one-shot command' : 'no other registered tab',
        });
        this.inFlight.delete(requestId);
        continue;
      }
      log.info('responder disconnected mid-request; re-sent to another tab', {
        sessionId: this.deps.sessionId,
        requestId,
        windowId: flight.windowKey,
      });
      flight.connectionId = next;
      this.deps.sendTo(next, flight.event);
    }
  }

  /**
   * The connection to ask: a registered one whose tab is in front, else any registered
   * one — newest first in both tiers, since the newest registration is the document most
   * likely to still be alive (a reconnect re-announces under its new connection id).
   *
   * A backgrounded phone and a visible desktop both registered is the case this exists
   * for: the phone cannot run script, so asking it is a guaranteed timeout, while asking
   * both is a duplicated side effect the moment the phone wakes.
   */
  private pickResponder(windowKey: string): ConnectionId | null {
    const registered = (this.readyConnections.get(windowKey) ?? []).filter((id) =>
      this.deps.hasConnection(id),
    );
    if (registered.length === 0) return null;
    for (let i = registered.length - 1; i >= 0; i--) {
      const state = connectionPresence(this.deps.sessionId, registered[i]!);
      if (state === undefined || state === 'visible') return registered[i]!;
    }
    return registered[registered.length - 1]!;
  }

  /**
   * The key readiness is filed under — see `handleReady` for why it keeps the monitor scope.
   *
   * Windows stored under a bare raw id (devtools preview windows, created via the
   * iframe-SDK proxy with no monitor) still resolve: getWindow() matches them exactly,
   * and the fallback strips a scope they never had.
   */
  private resolveKey(windowId: string): string {
    return (
      this.deps.windowState.getWindow(windowId)?.id ??
      this.deps.windowState.handleMap.getRawWindowId(windowId)
    );
  }

  /** An iframe reporting that its app has registered and can be commanded. */
  handleReady(
    event: ClientEventOf<typeof ClientEventType.APP_PROTOCOL_READY>,
    connectionId: ConnectionId,
  ): void {
    // The frontend reports the monitor-scoped key (e.g. "0/ai-chat", from the window
    // element's data-window-id). Keep that scope: readiness is per window, and the raw
    // AI-facing id ("ai-chat") names one window *per monitor*, so collapsing to it would
    // let monitor 0's registration mark monitor 1's window ready — leaving monitor 1's
    // agent talking to an iframe that never registered. app_query/app_command wait on
    // the same resolved key (see requireAppReady).
    const windowKey = this.resolveKey(event.windowId);
    // Newest last: re-registering moves a connection to the end rather than duplicating it.
    const connections = (this.readyConnections.get(windowKey) ?? []).filter(
      (id) => id !== connectionId,
    );
    connections.push(connectionId);
    this.readyConnections.set(windowKey, connections);
    const wasReady = this.deps.windowState.getWindow(windowKey)?.appProtocol ?? false;
    // The replay policy is recorded from the same frame that decides the replay below, and
    // before it. That ordering is the whole reason this is correct: the commands about to
    // go out are filtered by the registration that *just came up*, never by the one that
    // was there before the remount. An app that added `replay: 'never'` in a rebuild is
    // honoured on the first reload after it, and one that dropped it is not filtered by a
    // policy it no longer declares (setAppProtocol replaces the set rather than merging).
    this.deps.windowState.setAppProtocol(windowKey, event.noReplay);
    // Readiness is this session's fact about this session's iframe — a second browser
    // showing the same app on the same monitor has the same window key and a document
    // that has said nothing.
    actionEmitter.notifyAppReady(this.deps.sessionId, windowKey);
    // Replay stored commands only on re-registration (reload/remount), not first time —
    // and never on a re-announce, where the desktop is repeating a registration it
    // already witnessed and the iframe never remounted (see AppProtocolReadyEvent).
    //
    // Replayed to the registering connection only: it is the document that remounted and
    // lost its state. Every other tab's copy kept its own, and re-sending to it would
    // re-apply commands it has already run.
    if (wasReady && !event.reannounce) {
      this.replayCommands(windowKey, connectionId);
    }
  }

  /**
   * The window's iframe is gone. Reopening the app under the same key mounts a new
   * document, which must register again before anything is commanded to it.
   */
  forgetReady(windowId: string): void {
    actionEmitter.forgetAppReady(this.deps.sessionId, windowId);
    this.readyConnections.delete(windowId);
  }

  /** A socket closed: whatever its iframes registered can no longer answer. */
  forgetConnection(connectionId: ConnectionId): void {
    for (const [windowKey, connections] of this.readyConnections) {
      const remaining = connections.filter((id) => id !== connectionId);
      if (remaining.length === 0) this.readyConnections.delete(windowKey);
      else this.readyConnections.set(windowKey, remaining);
    }
    // After the registrations are gone, so the dead connection cannot be picked again.
    this.reassignFrom(connectionId);
  }

  /** An app emitted on a declared channel. */
  handleAppEvent(event: ClientEventOf<typeof ClientEventType.APP_EVENT>): void {
    // Pass the monitor-scoped window key (from the iframe element's data-window-id)
    // through as-is — ContextPool indexes subscriptions by that key. Collapsing it to the
    // raw AI-facing id would deliver monitor 1's app events to a subscriber watching
    // monitor 0's copy of the same app, since both windows share the raw id.
    // `wakeAgent` is the app asking for its own agent as well as its subscribers.
    // Passed through untouched: whether an agent exists to wake, and whether the
    // window even belongs to an app, are the coordinator's questions to answer.
    this.deps.getPool()?.notifyAppChannel(event.windowId, event.channel, event.payload, undefined, {
      wakeAgent: event.wakeAgent === true,
    });
  }

  /**
   * Deliver an unsolicited real-browser event to this session's Real Browser windows.
   *
   * This is the server-side twin of the `APP_EVENT` client frame: both land on
   * `ContextPool.notifyAppChannel`, so channel subscriptions, debounce, the per-window rate
   * cap and the `<app:event>` framing are shared. The event does *not* detour through the
   * iframe to be re-emitted via `app.emit()` — it already arrives in canonical form, the
   * iframe would add nothing but two hops, and a window mid-reload would silently drop it.
   *
   * A session with no Real Browser window open is not an error: the channels are declared
   * on that window, so with no window there is nobody who could have subscribed. Drop it.
   */
  routeBridgeEvent(channel: string, payload: unknown): void {
    const pool = this.deps.getPool();
    if (!pool) return;

    for (const window of this.deps.windowState.listWindows()) {
      if (window.appId !== BRIDGE_APP_ID) continue;
      pool.notifyAppChannel(window.id, channel, payload);
    }
  }

  /**
   * Replay stored app commands to a window that just re-registered.
   * This restores iframe app state after reload or remount.
   *
   * Two things a replayed command carries that a fresh one does not:
   *
   * - it may be **skipped**, if the running registration declared `replay: 'never'` for it
   *   (`AppProtocolReadyEvent.noReplay`). Those are the commands that append, notify, or
   *   are otherwise one-shot; re-sending one does not restore state, it duplicates an
   *   effect the app has already had.
   * - it is **stamped** `replayed: true`, so a handler that wants to reconcile against
   *   state it restored from its own persistence can tell the two apart (`ctx.replayed`)
   *   instead of having to opt out wholesale.
   *
   * Matching is by name, against the set as sent — a list of *spellings to refuse*, not
   * canonical names to resolve. The server has no alias table (the alias→canonical map
   * never leaves the iframe), so the SDK sends every spelling of an opted-out command,
   * canonical name and aliases alike. Erring here is asymmetric, which is why the
   * spelling-list framing is the right one: a missed skip re-applies a non-idempotent
   * command, while an over-skip merely leaves a piece of state unrestored.
   */
  private replayCommands(windowId: string, connectionId: ConnectionId): void {
    const commands = this.deps.windowState.getAppCommands(windowId);
    if (commands.length === 0) return;

    const noReplay = this.deps.windowState.getNoReplayCommands(windowId);
    const replayable = commands.filter(
      (request) => !(request.kind === 'command' && noReplay.has(request.command)),
    );
    const skipped = commands.length - replayable.length;

    // `skipped` is named, not silent: an app author who set `replay: 'never'` has no other
    // way to see the policy took effect, and a command that vanishes without a word reads
    // exactly like a command the server forgot to send.
    log.info('replaying app commands to window', {
      sessionId: this.deps.sessionId,
      windowId,
      replayed: replayable.length,
      skippedByNeverReplay: skipped,
    });
    this.deps.windowState.recordWindowEvent(
      windowId,
      'replayed',
      `${replayable.length} command(s) re-sent after remount` +
        (skipped ? `, ${skipped} skipped by replay: 'never'` : ''),
    );
    for (let i = 0; i < replayable.length; i++) {
      const request = replayable[i]!;
      this.deps.sendTo(connectionId, {
        type: ServerEventType.APP_PROTOCOL_REQUEST,
        requestId: `replay-${windowId}-${Date.now()}-${i}`,
        windowId,
        // A copy: the stored request is the one the agent originally sent, and it is
        // replayed again on the next remount. Stamping it in place would rewrite history.
        request: request.kind === 'command' ? { ...request, replayed: true } : request,
      });
    }
  }
}
