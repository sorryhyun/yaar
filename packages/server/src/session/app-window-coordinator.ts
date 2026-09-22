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
import {
  connectionPresence,
  hasBeenAway,
  isCompanionConnection,
  visibleFor,
} from './client-presence.js';
import { deadlines } from '../config.js';
import type { WindowStateRegistry } from './window-state.js';
import { actionEmitter, REPLAY_REQUEST_PREFIX } from './action-emitter.js';
import { createLogger } from '../observability/log.js';

const log = createLogger('AppWindowCoordinator');

/**
 * Windows whose responder changed since the agent last heard from them, per session.
 *
 * Module-level for the same reason `client-presence.ts` is: the note is read where a tool
 * result is built (`features/window/app-protocol.ts`), which holds a session id and a
 * window key but no coordinator.
 */
const responderSwitches = new Map<SessionId, Map<string, string>>();

/**
 * The note owed to an agent whose request was answered by a different copy of the window
 * than the one its earlier requests reached — taken, so it is told once per switch.
 */
export function takeResponderSwitchNote(
  sessionId: SessionId | string | undefined,
  windowKey: string,
): string | undefined {
  if (!sessionId) return undefined;
  const bySession = responderSwitches.get(sessionId as SessionId);
  const note = bySession?.get(windowKey);
  if (note === undefined) return undefined;
  bySession!.delete(windowKey);
  if (bySession!.size === 0) responderSwitches.delete(sessionId as SessionId);
  return note;
}

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
   * Per window key, the one connection this window's requests go to.
   *
   * Each tab's copy of an iframe has its own in-memory state — which project devtools has
   * open, whether its preview is up. Picking a responder afresh for every request let a
   * turn's requests land on different copies as soon as a tab's visibility changed: devtools
   * cloned `memo` in the phone's copy, and three commands later was answering from the
   * companion tab's copy, which had never heard of the clone, had no preview open, and
   * refused the deploy as a protocol mismatch. So a window keeps its responder until that
   * responder can no longer answer, and a change is announced (`takeResponderSwitchNote`)
   * instead of being silent.
   */
  private readonly pinned = new Map<string, ConnectionId>();

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
   * The connection to ask for this window: its pinned responder while that one can still
   * answer, else a fresh pick, which becomes the new pin.
   *
   * The pin gives way in exactly two cases: its socket is gone (or the tab no longer holds a
   * registration for the window), or its tab went to the background while another
   * registered tab is in front. The second is the phone-plus-companion case the companion
   * exists for — a backgrounded phone cannot run script, so staying pinned to it is a
   * timeout on every request. Either way the new copy has not seen what the old one did,
   * and the agent is told so rather than left to discover it.
   */
  private pickResponder(windowKey: string): ConnectionId | null {
    const registered = (this.readyConnections.get(windowKey) ?? []).filter((id) =>
      this.deps.hasConnection(id),
    );
    if (registered.length === 0) {
      this.pinned.delete(windowKey);
      return null;
    }

    const pin = this.pinned.get(windowKey);
    const pinAlive = !!pin && registered.includes(pin);
    if (pinAlive) {
      // The one move a pin makes while it can still answer: off the companion, back to
      // the tab the user is looking at, once that tab has settled. Answering from the
      // companion keeps working, but the user watches the agent act on a copy they
      // cannot see.
      const userTab = this.isCompanion(pin) ? this.settledUserTab(registered) : null;
      if (userTab) {
        this.pinned.set(windowKey, userTab);
        this.announceSwitch(windowKey, 'returned');
        return userTab;
      }
      if (this.canAnswer(pin) || !registered.some((id) => this.canAnswer(id))) return pin;
    }

    const next = this.rankResponders(registered)[0]!;
    this.pinned.set(windowKey, next);
    if (pin && pin !== next) this.announceSwitch(windowKey, pinAlive ? 'away' : 'gone');
    return next;
  }

  private isCompanion(connectionId: ConnectionId): boolean {
    return isCompanionConnection(this.deps.sessionId, connectionId);
  }

  /**
   * A registered user tab that has been in front for at least `userTabSettleMs`, or
   * null. The settle keeps a phone flicking between apps from dragging the pin back and
   * forth: each move hands the agent a copy that did not see the last one's commands.
   */
  private settledUserTab(registered: ConnectionId[]): ConnectionId | null {
    const settled = registered.filter((id) => {
      if (this.isCompanion(id)) return false;
      const shown = visibleFor(this.deps.sessionId, id);
      return shown !== undefined && shown >= deadlines.userTabSettleMs;
    });
    return settled.length > 0 ? this.rankResponders(settled)[0]! : null;
  }

  /**
   * The tab whose capture of this window should win, or null when any tab's will do.
   *
   * A capture goes to every desktop, and each one rasterizes its *own* copy of the iframe.
   * Those copies drift apart the moment an agent acts on one: devtools' `previewEval`
   * clicked a sheet open in the pinned copy, and the screenshot that came back first was
   * the companion tab's, where nothing had been clicked — the same picture three times
   * running while the DOM the agent was measuring changed under it. So the copy the agent
   * has been commanding is the one whose picture counts, while it can still paint.
   *
   * Read-only: a capture never moves the pin, so it cannot cause the switch it avoids.
   */
  captureResponder(windowId: string): ConnectionId | null {
    const windowKey = this.resolveKey(windowId);
    const pin = this.pinned.get(windowKey);
    if (!pin || !this.deps.hasConnection(pin) || !this.canAnswer(pin)) return null;
    return (this.readyConnections.get(windowKey) ?? []).includes(pin) ? pin : null;
  }

  /** Whether a connection's tab can run script — silence counts as yes, see client-presence. */
  private canAnswer(connectionId: ConnectionId): boolean {
    const state = connectionPresence(this.deps.sessionId, connectionId);
    return state === undefined || state === 'visible';
  }

  /**
   * Best first: a tab in front before one in the background, and among those in front, a
   * user's tab before the companion desktop.
   *
   * The companion used to win that second comparison, as the tab that never backgrounds —
   * every pin on it was a switch that never had to happen. But it is the copy nobody is
   * looking at: with a phone attached, every command the agent ran changed a screen the
   * user could not see, and the phone showed nothing happening. So the companion is the
   * fallback for a phone that cannot run script, not the first pick. Among user tabs, one
   * that has never been away still beats one that has, and the newest registration breaks
   * ties: it is the document most likely to still be alive.
   */
  private rankResponders(registered: ConnectionId[]): ConnectionId[] {
    const tier = (id: ConnectionId): number => {
      if (!this.canAnswer(id)) return 3;
      if (this.isCompanion(id)) return 2;
      return hasBeenAway(this.deps.sessionId, id) ? 1 : 0;
    };
    return registered
      .map((id, order) => ({ id, order, tier: tier(id) }))
      .sort((a, b) => a.tier - b.tier || b.order - a.order)
      .map((entry) => entry.id);
  }

  private announceSwitch(windowKey: string, reason: 'away' | 'gone' | 'returned'): void {
    const why =
      reason === 'gone'
        ? 'the tab that was answering disconnected'
        : reason === 'returned'
          ? "the user's own tab is back in front"
          : 'the tab that was answering went to the background';
    log.warn('app window responder changed', {
      sessionId: this.deps.sessionId,
      windowId: windowKey,
      reason,
    });
    this.deps.windowState.recordWindowEvent(windowKey, 'responder-changed', why);
    let bySession = responderSwitches.get(this.deps.sessionId);
    if (!bySession) {
      bySession = new Map();
      responderSwitches.set(this.deps.sessionId, bySession);
    }
    bySession.set(
      windowKey,
      `Note: this answer came from a different open copy of this app window than your ` +
        `earlier requests (${why}). That copy has its own in-memory state and did not run ` +
        `your earlier commands — re-check the state you depend on (e.g. which project or ` +
        `document is open) before continuing.`,
    );
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
    this.pinned.delete(windowId);
    takeResponderSwitchNote(this.deps.sessionId, windowId);
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
        requestId: `${REPLAY_REQUEST_PREFIX}${windowId}-${Date.now()}-${i}`,
        windowId,
        // A copy: the stored request is the one the agent originally sent, and it is
        // replayed again on the next remount. Stamping it in place would rewrite history.
        request: request.kind === 'command' ? { ...request, replayed: true } : request,
      });
    }
  }
}
