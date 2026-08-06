/**
 * LiveSession - Session-scoped container for multi-client support.
 *
 * A LiveSession owns all state for one logical session:
 * - ContextPool (agents, task routing)
 * - WindowStateRegistry (server-side window state)
 * - ReloadCache (fingerprint-based action caching)
 *
 * Multiple WebSocket connections can join the same LiveSession.
 * The session survives individual disconnects; only destroyed when
 * all connections leave (or explicit reset).
 *
 * It remains the aggregate root: it owns the registries, decides the order of its own
 * teardown, and is the only server→frontend gateway. Four policies that have their own
 * state or their own invariants live beside it rather than in it — `MonitorRegistry`,
 * `ClientEventController`, `SessionSnapshotService`, and `AppWindowCoordinator` — each
 * reached through this class and each given narrow callbacks rather than the session
 * itself, so none of them can reach back around it.
 */

import { join } from 'path';
import { ContextPool } from '../agents/context-pool.js';
import type { ContextMessage } from '../agents/context.js';
import { WindowStateRegistry } from './window-state.js';
import { LayoutContext } from './layout-context.js';
import { ReloadCache } from '../reload/cache.js';
import type { SessionId } from './types.js';
import { nextSessionEpoch } from './types.js';
import type { ConnectionId } from './broadcast-center.js';
import { getBroadcastCenter } from './broadcast-center.js';
import {
  ServerEventType,
  ClientEventType,
  type ClientEvent,
  type ServerEvent,
  type OSAction,
  type MonitorInfo,
  DEFAULT_MONITOR_ID,
} from '@yaar/shared';
import { SurfaceRegistry } from './surface-state.js';
import type { YaarWebSocket } from './types.js';
import { actionEmitter } from './action-emitter.js';
import type { ActionEvent } from './emitter-channels.js';
import { sessionEventRouter, type SessionEventSink } from './session-event-router.js';
import { ClientEventRouter } from './client-event-router.js';
import { ClientEventController } from './client-event-controller.js';
import { MonitorRegistry } from './monitor-registry.js';
import { SessionSnapshotService } from './session-snapshot-service.js';
import { AppWindowCoordinator } from './app-window-coordinator.js';
import { getConfigDir } from '../storage/storage-manager.js';
import { genId } from '../lib/ids.js';
import { getWarmPool } from '../providers/warm-pool.js';
import type { AITransport } from '../providers/types.js';
import { getHeadlessBrowser, getLocalBrowser } from '../lib/browser/index.js';
import { getHooksByEvent } from '../features/config/hooks.js';
import { subscriptionRegistry } from '../http/subscriptions.js';
import { revokeTokensForWindow } from '../http/iframe-tokens.js';
import { storageDocumentUri } from '../features/window/helpers.js';
import type { SessionLogger } from '../logging/index.js';
import {
  normalizeAgentKey,
  mapActionToSubscriptionEvent,
  summarizeAction,
} from '../features/window/subscription-events.js';

export interface LiveSessionOptions {
  restoreActions?: OSAction[];
  contextMessages?: ContextMessage[];
  savedThreadIds?: Record<string, string>;
  sessionLogger?: SessionLogger;
  /** Provider seam, defaulting to the global warm pool. See `ContextPool.acquireProvider`. */
  acquireProvider?: () => Promise<AITransport | null>;
}

/**
 * How far a monitor-tagged event travels.
 *
 * The frontend keeps every monitor's windows mounted (hidden, so iframe state survives
 * switches — see WindowManager.tsx) and the CLI panel renders a pane for every monitor.
 * Both assume every tab hears about every monitor. So window state and agent-stream
 * events go to the whole session: a tab looking at another desktop still has to mount
 * the window (a capture of it can be asked for at any time) and still renders the pane
 * the stream belongs in. Interactive surfaces (dialogs, toasts, prompts, notifications)
 * stay on the monitor that asked — with two tabs on two desktops, the same dialog on
 * both screens would leave a stale twin on one of them once the other answers.
 */
export function monitorEventScope(event: ServerEvent): 'session' | 'monitor' {
  switch (event.type) {
    case ServerEventType.AGENT_THINKING:
    case ServerEventType.AGENT_RESPONSE:
    case ServerEventType.TOOL_PROGRESS:
    case ServerEventType.ERROR:
      return 'session';
    case ServerEventType.ACTIONS:
      return event.actions.length > 0 &&
        event.actions.every((action) => action.type.startsWith('window.'))
        ? 'session'
        : 'monitor';
    default:
      return 'monitor';
  }
}

export class LiveSession {
  readonly sessionId: SessionId;
  /**
   * This incarnation's stamp. Two LiveSessions can carry the same `sessionId` over a
   * server's lifetime — one evicted, one created later under the id a client asked for —
   * and only the epoch tells them apart. Sent to the client in SESSION_ATTACHED.
   */
  readonly epoch: number = nextSessionEpoch();
  private connections = new Map<ConnectionId, YaarWebSocket>();

  private pool: ContextPool | null = null;
  private initPromise: Promise<boolean> | null = null;
  private initialized = false;
  readonly windowState: WindowStateRegistry;
  readonly layoutContext: LayoutContext;
  readonly reloadCache: ReloadCache;

  /** The session's virtual desktops. See `monitor-registry.ts`. */
  private readonly monitorRegistry: MonitorRegistry;

  /**
   * The notifications, dialogs, and prompts currently on the user's screen. Windows have
   * `windowState`; this is the same idea for everything else the snapshot has to be able
   * to name. See `surface-state.ts`.
   */
  private readonly surfaces = new SurfaceRegistry();

  /** Windows, surfaces, and busy agents, on demand. See `session-snapshot-service.ts`. */
  private readonly snapshots: SessionSnapshotService;

  /** App readiness, replay, and channel routing. See `app-window-coordinator.ts`. */
  private readonly appWindows: AppWindowCoordinator;

  /**
   * User messages this session has already taken responsibility for.
   *
   * The client keeps an outbox and resends anything it never got an ack for — which is the
   * only way a command typed into a dropping socket survives at all. But "no ack" and "not
   * delivered" are different: the message may have arrived and been queued a moment before
   * the socket died. Without this set, the resend would run it a second time, and the user
   * would watch the agent do their bidding twice.
   *
   * Bounded, because a session can outlive any number of messages and nothing here is
   * worth a leak. An id evicted from the tail is one from thousands of messages ago; its
   * outbox entry was acked and dropped long before.
   *
   * Acceptance stays here, at the session boundary, rather than in the controller or a task
   * processor: it is a fact about what this session has taken on, and a processor that
   * decided it would be deciding it once per queue.
   */
  private readonly acceptedMessageIds = new Set<string>();
  private static readonly MAX_TRACKED_MESSAGE_IDS = 500;

  private restoredContext: ContextMessage[];
  private savedThreadIds?: Record<string, string>;

  /** True once launch hooks have been executed — prevents re-firing on reconnect or second tab. */
  launchHooksExecuted = false;

  /**
   * Created at server startup, passed via options. Owned by LiveSession so that user
   * interactions are logged even before the pool is initialized (i.e., before the user
   * sends their first message).
   */
  private sessionLogger: SessionLogger | null = null;

  /** The client frames this session answers. See `client-event-controller.ts`. */
  private readonly router: ClientEventRouter;

  /** Provider seam, handed to the ContextPool when it is created. */
  private readonly acquireProvider?: () => Promise<AITransport | null>;

  /**
   * This session's registration with the process event router. Held so `cleanup()` can
   * detach *this* object's sink rather than whatever is currently registered under the id
   * — see `SessionEventRouter.detach`.
   */
  private readonly eventSink: SessionEventSink;

  constructor(sessionId: SessionId, options: LiveSessionOptions = {}) {
    this.sessionId = sessionId;
    this.restoredContext = options.contextMessages ?? [];
    this.savedThreadIds = options.savedThreadIds;
    this.acquireProvider = options.acquireProvider;

    this.windowState = new WindowStateRegistry();
    this.layoutContext = new LayoutContext(this.windowState, this.windowState.handleMap);
    const cachePath = join(getConfigDir(), 'reload-cache', `${sessionId}.json`);
    this.reloadCache = new ReloadCache(cachePath);

    this.sessionLogger = options.sessionLogger ?? null;

    if (options.restoreActions && options.restoreActions.length > 0) {
      this.windowState.restoreFromActions(options.restoreActions);
      this.regrantRestoredDocuments(options.restoreActions);
    }

    this.monitorRegistry = new MonitorRegistry({
      sessionId,
      broadcast: (event) => this.broadcast(event),
      sendTo: (connectionId, event) => this.sendTo(connectionId, event),
      subscribeConnection: (connectionId, monitorId) =>
        getBroadcastCenter().subscribeToMonitor(connectionId, monitorId),
      connectionMonitor: (connectionId) => getBroadcastCenter().monitorOf(connectionId),
      unsubscribeMonitor: (monitorId) =>
        getBroadcastCenter().unsubscribeMonitor(sessionId, monitorId),
      setViewport: (monitorId, viewport) => this.layoutContext.setViewport(monitorId, viewport),
      clearLayout: (monitorId) => this.layoutContext.clearMonitor(monitorId),
      removeMonitorAgent: (monitorId) => this.pool?.removeMonitorAgent(monitorId),
    });

    this.snapshots = new SessionSnapshotService({
      sessionId,
      windowState: this.windowState,
      surfaces: this.surfaces,
      listAgents: () => this.pool?.listAgents() ?? [],
    });

    this.appWindows = new AppWindowCoordinator({
      sessionId,
      windowState: this.windowState,
      broadcast: (event) => this.broadcast(event),
      getPool: () => this.pool,
    });

    // Everything scoped to a window dies with it: its iframe tokens, its cached actions,
    // its subscriptions, its app agent's queue, and its readiness record.
    //
    // Registered here rather than after pool init, where the pool half of it used to
    // live, because **windows outlive the pool**: a restore replays them into the
    // constructor above, and `POST /api/iframe-token` mints against sessions that never
    // get one. A teardown a pool-less session cannot reach is a credential that is never
    // revoked — which is the state this whole chain was in for tokens.
    this.windowState.setOnWindowClose((wid, appId, monitorId) => {
      // Both id spellings: a token minted by `window.create` is keyed by the raw id, one
      // minted by restore or a reconnect by the scoped handle, and several may be out at
      // once (one per connected tab). Scoped to this window's own monitor, so the same
      // app open on another monitor keeps its own token.
      const raw = this.windowState.handleMap.getRawWindowId(wid);
      revokeTokensForWindow(this.sessionId, wid, monitorId);
      if (raw !== wid) revokeTokensForWindow(this.sessionId, raw, monitorId);
      this.reloadCache.invalidateForWindow(wid);
      this.pool?.handleWindowClose(wid, appId, monitorId);
      subscriptionRegistry.clearForWindow(wid);
      this.appWindows.forgetReady(wid);
    });

    this.router = new ClientEventRouter(
      new ClientEventController({
        sessionId,
        windowState: this.windowState,
        surfaces: this.surfaces,
        reloadCache: this.reloadCache,
        monitors: this.monitorRegistry,
        appWindows: this.appWindows,
        snapshots: this.snapshots,
        getPool: () => this.pool,
        getSessionLogger: () => this.getSessionLogger(),
        broadcast: (event) => this.broadcast(event),
        sendTo: (connectionId, event) => this.sendTo(connectionId, event),
        claimMessageId: (messageId) => this.claimMessageId(messageId),
        resetSession: (connectionId) => this.handleReset(connectionId),
        closeBrowsers: () => this.closeBrowsers(),
      }).routes(),
    );

    // Everything this session hears from the process-global emitter: actions (window state
    // tracking + budget recording), app protocol requests, forwarded session-scoped events,
    // and unsolicited real-browser frames. The router holds the subscriptions — one set for
    // the whole process — and this session is simply reachable or not, by id. Detached in
    // cleanup(); see `session-event-router.ts`.
    this.eventSink = {
      handleAction: (event) => this.handleEmittedAction(event),
      handleAppProtocolRequest: (data) => this.appWindows.handleProtocolRequest(data),
      // The real browser reporting something nobody asked for (a native dialog fired, a tab
      // being driven navigated). The frame arrives on a process-global socket with no session
      // on it, so every session hears it and decides for itself whether it has a window
      // that cares.
      handleBridgeEvent: (data) => this.appWindows.routeBridgeEvent(data.channel, data.payload),
      broadcast: (event) => this.broadcast(event),
    };
    sessionEventRouter.attach(sessionId, this.eventSink);
  }

  /**
   * Re-grant each restored window the document it renders.
   *
   * A server restart starts with an empty grant registry, but the `window.create` being
   * replayed still carries its content path — so the one piece of window-scoped authority
   * a restart *can* recover is recovered here, and restart-restore ends up strictly better
   * than it was when this lived on the token (a stale token is not in the map at all).
   *
   * Deliberately not recovered: the permissions a caller added at create time and the
   * files it named to the app. Neither was ever written to the session log, and inventing
   * them would be a grant nobody made — the same accepted loss delegated grants already
   * carry across a restart.
   *
   * Restored ids are monitor-scoped handles ("0/dock") and `restoreFromActions` has just
   * registered them, so no monitor need be passed: the handle resolves exactly.
   */
  private regrantRestoredDocuments(actions: OSAction[]): void {
    for (const action of actions) {
      if (action.type !== 'window.create' || action.content?.renderer !== 'iframe') continue;
      const uri = storageDocumentUri(action.content.data);
      if (uri) this.windowState.grantWindowAccess(action.windowId, [{ uri, verbs: ['read'] }]);
    }
  }

  /**
   * An OS Action emitted by a tool anywhere in this session: track it in window state,
   * bill it to its monitor's budget, and wake whoever is watching that window.
   */
  private handleEmittedAction(event: ActionEvent): void {
    const rawWindowId = (event.action as { windowId?: string }).windowId;
    // Resolved *before* the action is applied. `window.close` removes the handle, so a
    // lookup afterwards answers with the raw id — which is what went out on the wire to
    // the frontend, and to every subscriber, for every close an app performed. The
    // frontend then had to guess the monitor back by scanning its keys for a matching
    // suffix, and with the same app open on two monitors it could guess wrong and close
    // the other one.
    const priorHandle = rawWindowId
      ? this.windowState.handleMap.resolve(rawWindowId, event.monitorId)
      : undefined;

    this.windowState.handleAction(event.action, event.monitorId);

    // ...and re-asked afterwards, because `window.create` is the mirror case: it *mints*
    // the handle, so before the action there is nothing to resolve and the pre-lookup
    // necessarily answers with the raw id. Sending that raw id to the frontend is not
    // cosmetic — the frontend has no monitor to key the new window by either, so it falls
    // back to whichever monitor that tab is *looking at* (`applyWindowAction`), and on a
    // two-monitor desktop that is routinely the wrong one. The two registries then hold
    // the same window under different keys forever: the server says `0/preview`, the tab
    // says `1/preview`, every later app_query resolves to no DOM element and reports
    // "Window element not found", and nothing short of closing and re-creating the window
    // repairs it. Only `create` needs this — for everything else the prior handle is the
    // authoritative one, and for `close` it is the *only* one left.
    const windowHandle = rawWindowId
      ? (priorHandle ??
        this.windowState.handleMap.resolve(rawWindowId, event.monitorId) ??
        rawWindowId)
      : undefined;
    if (event.monitorId && this.pool) {
      this.pool.recordMonitorAction(event.monitorId);
    }
    // Wake iframe apps subscribed to yaar://windows (see http/subscriptions.ts).
    if (event.action.type.startsWith('window.') && windowHandle) {
      subscriptionRegistry.notifyChange(`yaar://windows/${windowHandle}`, this.sessionId);
    }
    if (this.pool) {
      const changeEvent = mapActionToSubscriptionEvent(event.action);
      if (changeEvent) {
        const windowId = (event.action as { windowId?: string }).windowId;
        if (windowId) {
          this.pool.notifyWindowSubscribers(
            windowId,
            changeEvent,
            summarizeAction(event.action, changeEvent),
            normalizeAgentKey(event.agentId),
          );
        }
      }
    }
    // Actions from non-agent contexts (iframe verb proxy, HTTP routes) have no
    // ToolActionBridge to broadcast them to the frontend, so do it directly.
    if (event.agentId?.startsWith('iframe:')) {
      const action = event.action;
      const raw = rawWindowId;
      const handle = windowHandle;
      // Carry the requestId through, as ToolActionBridge does on the agent path.
      // An action awaiting feedback is only answerable if the frontend knows which
      // request to answer: `window.capture` reads the id off the action itself and
      // skips the capture without one. Dropping it here is why devtools could open a
      // preview and never screenshot it — the request went out, nothing came back, and
      // the read timed out into "no screenshot" every time.
      const patch = {
        ...(handle && handle !== raw ? { windowId: handle } : {}),
        ...(event.requestId ? { requestId: event.requestId } : {}),
      };
      const stamped = (
        Object.keys(patch).length > 0 ? { ...action, ...patch } : action
      ) as OSAction;
      this.broadcast({
        type: ServerEventType.ACTIONS,
        actions: [stamped],
        monitorId: event.monitorId,
      });
      this.sessionLogger?.logAction(stamped);
    }
  }

  addConnection(connectionId: ConnectionId, ws: YaarWebSocket): void {
    this.connections.set(connectionId, ws);
    console.log(
      `[LiveSession ${this.sessionId}] Connection added: ${connectionId} (total: ${this.connections.size})`,
    );
    // Warm the pool (provider + monitor agent + persistent provider stream)
    // while the user is still looking at an empty desktop, so their first
    // message skips provider setup, process spawn, and the MCP handshake.
    if (!this.initialized) {
      void this.ensureInitialized();
    }
  }

  removeConnection(connectionId: ConnectionId): void {
    this.connections.delete(connectionId);
    console.log(
      `[LiveSession ${this.sessionId}] Connection removed: ${connectionId} (total: ${this.connections.size})`,
    );
  }

  hasConnections(): boolean {
    return this.connections.size > 0;
  }

  /**
   * Single gateway for all server→frontend events.
   *
   * Every event emitted by agents, tools, or non-agent code (proxy, hooks)
   * MUST flow through this method. It handles monitor-scoped routing via
   * BroadcastCenter. Direct calls to publishToSession/publishToMonitor
   * from outside LiveSession are not allowed.
   */
  broadcast(event: ServerEvent): void {
    // Mirror the surfaces the client is being told to show. This is the only gateway they
    // travel through, so recording here is what makes the snapshot able to say "this
    // dialog is still up" — and, just as importantly, "this one is not".
    if (event.type === ServerEventType.ACTIONS) {
      for (const action of event.actions) this.surfaces.record(action);
    }

    const monitorId = (event as { monitorId?: string }).monitorId;
    const bc = getBroadcastCenter();
    if (!monitorId) {
      bc.publishToSession(this.sessionId, event);
      return;
    }
    // A deleted monitor's in-flight events go nowhere: agent teardown is async, so a
    // turn already running can still emit after REMOVE_MONITOR — and delivering those
    // would have the frontend re-create windows of a desktop the user just closed.
    if (!this.monitorRegistry.has(monitorId)) return;
    if (monitorEventScope(event) === 'session') {
      bc.publishToSession(this.sessionId, event);
    } else {
      bc.publishToMonitor(this.sessionId, monitorId, event);
    }
  }

  sendTo(connectionId: ConnectionId, event: ServerEvent): void {
    getBroadcastCenter().publishToConnection(event, connectionId);
  }

  getSessionLogger(): SessionLogger | null {
    return this.pool?.getSessionLogger() ?? this.sessionLogger;
  }

  /**
   * Generate a snapshot of current windows as window.create actions.
   * Used when a new connection joins an existing session.
   * Generates fresh iframe tokens for iframe windows.
   */
  async generateSnapshot(): Promise<OSAction[]> {
    return this.snapshots.windowActions();
  }

  /**
   * Execute launch hooks (e.g., opening dock on startup).
   * Called on fresh session connect and after reset.
   */
  async executeLaunchHooks(connectionId: ConnectionId): Promise<void> {
    if (this.launchHooksExecuted) return;
    this.launchHooksExecuted = true;

    try {
      const hooks = await getHooksByEvent('launch');
      for (const hook of hooks) {
        if (hook.action.type === 'interaction') {
          const messageId = genId(`hook-${hook.id}`);
          await this.routeMessage(
            { type: ClientEventType.USER_MESSAGE, content: hook.action.payload, messageId },
            connectionId,
          );
        } else if (hook.action.type === 'os_action') {
          const action = hook.action.payload as OSAction;
          const hookLogger = this.getSessionLogger();
          if (action.type.startsWith('window.')) {
            this.windowState.handleAction(action, DEFAULT_MONITOR_ID);
            // Stamp the handle onto the action so frontend receives the scoped windowId
            const raw = (action as { windowId?: string }).windowId;
            const resolved = raw ? (this.windowState.handleMap.resolve(raw) ?? raw) : undefined;
            const stamped =
              resolved && resolved !== raw
                ? ({ ...action, windowId: resolved } as OSAction)
                : action;
            hookLogger?.logAction(stamped);
            this.broadcast({
              type: ServerEventType.ACTIONS,
              actions: [stamped],
              monitorId: DEFAULT_MONITOR_ID,
            });
          } else {
            hookLogger?.logAction(action);
            this.broadcast({
              type: ServerEventType.ACTIONS,
              actions: [action],
              monitorId: DEFAULT_MONITOR_ID,
            });
          }
        }
      }
    } catch (err) {
      console.error('Failed to execute launch hooks:', err);
    }
  }

  private async ensureInitialized(): Promise<boolean> {
    if (this.initialized) return true;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.doInitialize();
    const result = await this.initPromise;
    this.initPromise = null;
    return result;
  }

  private async doInitialize(): Promise<boolean> {
    console.log(`[LiveSession ${this.sessionId}] Initializing pool`);

    await this.reloadCache.load();

    this.pool = new ContextPool(
      this.sessionId,
      this.windowState,
      this.reloadCache,
      this.broadcast.bind(this),
      this.restoredContext,
      this.savedThreadIds,
      this.acquireProvider,
    );

    // The window-close teardown (including `pool.handleWindowClose`) is wired in the
    // constructor — see there for why it cannot wait for the pool to exist.

    // Pass the session-owned logger (if already created by early user interactions)
    // so the pool reuses the same log directory instead of creating a second one.
    const success = await this.pool.initialize(this.sessionLogger ?? undefined);
    this.initialized = success;
    return success;
  }

  /**
   * Take responsibility for a message id, or report that this session already had.
   * Evicts the oldest once the set is full.
   */
  private claimMessageId(messageId: string): boolean {
    if (this.acceptedMessageIds.has(messageId)) return false;
    if (this.acceptedMessageIds.size >= LiveSession.MAX_TRACKED_MESSAGE_IDS) {
      const oldest = this.acceptedMessageIds.values().next().value;
      if (oldest !== undefined) this.acceptedMessageIds.delete(oldest);
    }
    this.acceptedMessageIds.add(messageId);
    return true;
  }

  /** Close every browser session this host holds — headless sandbox and real Chrome. */
  private closeBrowsers(): void {
    getHeadlessBrowser()
      .closeAll()
      .catch(() => {});
    getLocalBrowser()
      .closeAll()
      .catch(() => {});
  }

  private async handleReset(connectionId: ConnectionId): Promise<void> {
    if (this.pool) {
      await this.pool.reset();
    } else {
      // Pool not yet initialized — still flush stale warm-pool providers
      // and clear restored state so the next pool init starts fresh
      console.log('[LiveSession] Reset before pool init — flushing warm-pool providers');
      this.restoredContext = [];
      this.savedThreadIds = undefined;
      await getWarmPool().resetCodexProviders();
    }
    this.launchHooksExecuted = false;
    await this.executeLaunchHooks(connectionId);
  }

  /**
   * Route incoming messages to the appropriate handler.
   *
   * The session decides two things before the controller sees the frame: whether the pool
   * exists, and — for a user message — whether this session has already taken the id. Both
   * are properties of the session, not of any one handler.
   */
  async routeMessage(event: ClientEvent, connectionId: ConnectionId): Promise<void> {
    // Lazy initialize on first message that needs the pool
    if (
      !this.initialized &&
      (event.type === ClientEventType.USER_MESSAGE ||
        event.type === ClientEventType.WINDOW_MESSAGE ||
        event.type === ClientEventType.APP_INTERACTION ||
        event.type === ClientEventType.COMPONENT_ACTION)
    ) {
      const success = await this.ensureInitialized();
      if (!success) {
        // The message is dead, and the client is holding an id for it. Saying so is the
        // whole point: this used to console.error and return, and the chip on the user's
        // screen sat at "queued" for a message that was never going to run.
        console.error(`[LiveSession ${this.sessionId}] Failed to initialize pool`);
        this.sendTo(connectionId, {
          type: ServerEventType.ERROR,
          error: 'Message dropped: the agent pool could not be initialized.',
          messageId: (event as { messageId?: string }).messageId,
        });
        return;
      }
    }

    await this.router.dispatch(event, connectionId);
  }

  /** The session's monitors. Authoritative — the client renders this, it does not mint it. */
  getMonitors(): MonitorInfo[] {
    return this.monitorRegistry.list();
  }

  /** Whether this session has that monitor. The same question the client's list answers. */
  hasMonitor(monitorId: string): boolean {
    return this.monitorRegistry.has(monitorId);
  }

  /**
   * Delete a monitor. The verb door's route to the one definition of what that means —
   * see `MonitorRegistry.remove`. Resolves once the monitor's agent is gone.
   */
  removeMonitor(monitorId: string): Promise<void> {
    return this.monitorRegistry.remove(monitorId);
  }

  getPool(): ContextPool | null {
    return this.pool;
  }

  /** Whether an app interaction can overtake the socket queue to steer its active turn. */
  hasActiveAppAgentTurn(windowId: string): boolean {
    return this.pool?.hasActiveAppAgentTurn(windowId) ?? false;
  }

  async cleanup(): Promise<void> {
    sessionEventRouter.detach(this.sessionId, this.eventSink);

    // A session can be torn down while its pool is still being built — a connection that
    // opens and closes before `doInitialize` resolves, which is every short-lived client
    // and every test that boots and disposes. Without this wait, `this.pool` is still null
    // below, so nothing is cleaned; the init then finishes and assigns a live pool to a
    // session nobody holds. Its monitor agent keeps a slot in the *global* AgentLimiter
    // that no code path will ever release, so the process quietly loses one agent slot per
    // such connection until every later session is refused an agent outright.
    if (this.initPromise) {
      await this.initPromise.catch(() => undefined);
    }

    // Force-clear any pending requests/dialogs/app-requests for this session
    // so awaiting tools unblock immediately instead of waiting for timeouts.
    actionEmitter.clearPendingForSession(this.sessionId);

    // Flush buffered session logs before tearing down the pool.
    // The pool logger and sessionLogger may be the same instance (if the pool
    // reused the session-owned logger), so dispose whichever is active.
    const poolLogger = this.pool?.getSessionLogger();
    if (poolLogger && poolLogger !== this.sessionLogger) {
      await poolLogger.dispose();
    }
    await this.sessionLogger?.dispose();
    this.sessionLogger = null;

    if (this.pool) {
      await this.pool.cleanup();
      this.pool = null;
    }

    subscriptionRegistry.clearForSession(this.sessionId);
    this.windowState.clear();
    this.initialized = false;
  }
}
