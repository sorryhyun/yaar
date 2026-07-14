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
  DEFAULT_MONITOR_ID,
  MAX_MONITORS,
  BRIDGE_APP_ID,
  type ClientEvent,
  type ServerEvent,
  type OSAction,
  type MonitorInfo,
  type AppProtocolRequest,
  type ActiveAgentSnapshot,
} from '@yaar/shared';
import { SurfaceRegistry } from './surface-state.js';
import type { YaarWebSocket } from './types.js';
import { actionEmitter } from './action-emitter.js';
import { getConfigDir } from '../storage/storage-manager.js';
import { getWarmPool } from '../providers/warm-pool.js';
import { getHeadlessBrowser, getLocalBrowser } from '../lib/browser/index.js';
import { getHooksByEvent } from '../features/config/hooks.js';
import { recordEmit } from '../features/window/protocol-log.js';
import { subscriptionRegistry } from '../http/subscriptions.js';
import { dbg as dbgLine } from './action-emitter.js';
import { refreshIframeTokens } from '../logging/window-restore.js';
import type { SessionLogger } from '../logging/index.js';
import {
  normalizeAgentKey,
  mapActionToSubscriptionEvent,
  summarizeAction,
} from '../features/window/subscription-events.js';
import { getAppMeta } from '../features/apps/discovery.js';

export interface LiveSessionOptions {
  restoreActions?: OSAction[];
  contextMessages?: ContextMessage[];
  savedThreadIds?: Record<string, string>;
  sessionLogger?: SessionLogger;
}

/**
 * Subscribe to session-scoped emitter channels that filter by sessionId
 * and forward matching events to a broadcast function.
 *
 * Returns a cleanup function that removes all listeners at once.
 */
function subscribeSessionChannels(
  sessionId: SessionId,
  broadcast: (event: ServerEvent) => void,
  channels: string[],
): () => void {
  const handler = (data: { sessionId: string; event: ServerEvent }) => {
    if (data.sessionId === sessionId) {
      broadcast(data.event);
    }
  };
  for (const ch of channels) {
    actionEmitter.on(ch, handler);
  }
  return () => {
    for (const ch of channels) {
      actionEmitter.off(ch, handler);
    }
  };
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

  // Session-scoped state
  private pool: ContextPool | null = null;
  private initPromise: Promise<boolean> | null = null;
  private initialized = false;
  readonly windowState: WindowStateRegistry;
  readonly layoutContext: LayoutContext;
  readonly reloadCache: ReloadCache;

  /**
   * The session's monitors — the virtual desktops, and the authoritative list of them.
   *
   * There is deliberately no `activeMonitorId` beside this. A session has N connections;
   * "the monitor the user is looking at" is a property of a *connection*, and collapsing
   * it to one field per session made it last-writer-wins: two tabs on different monitors,
   * and tab B's subscribe silently retargeted tab A's monitor-less actions. Where the
   * user is looking now lives where it always belonged — in the connection, held by the
   * BroadcastCenter — and nothing is monitor-less any more, so nothing needs to ask.
   *
   * The list itself was client state, minted from a per-tab counter: two tabs each made
   * a monitor "1", collided on one server-side agent, and neither could see the other's.
   * So the server mints the ids and broadcasts the list.
   */
  private monitors: MonitorInfo[] = [{ id: DEFAULT_MONITOR_ID, label: 'Monitor 1' }];

  /**
   * The notifications, dialogs, and prompts currently on the user's screen. Windows have
   * `windowState`; this is the same idea for everything else the snapshot has to be able
   * to name. See `surface-state.ts`.
   */
  private readonly surfaces = new SurfaceRegistry();

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
   */
  private readonly acceptedMessageIds = new Set<string>();
  private static readonly MAX_TRACKED_MESSAGE_IDS = 500;

  // Restored state
  private restoredContext: ContextMessage[];
  private savedThreadIds?: Record<string, string>;

  /** True once launch hooks have been executed — prevents re-firing on reconnect or second tab. */
  launchHooksExecuted = false;

  // Session logger — created at server startup, passed via options.
  // Owned by LiveSession so that user interactions are logged even before the
  // pool is initialized (i.e., before the user sends their first message).
  private sessionLogger: SessionLogger | null = null;

  // Action listener for window state tracking
  private unsubscribeAction: (() => void) | null = null;
  // App protocol listener for iframe communication
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private appProtocolListener: ((...args: any[]) => void) | null = null;
  // Session-scoped channel listeners (approval-request, user-prompt)
  private unsubscribeSessionChannels: (() => void) | null = null;
  // Unsolicited frames from the YAAR Bridge extension (real-browser dialogs / navigations)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private bridgeEventListener: ((...args: any[]) => void) | null = null;

  constructor(sessionId: SessionId, options: LiveSessionOptions = {}) {
    this.sessionId = sessionId;
    this.restoredContext = options.contextMessages ?? [];
    this.savedThreadIds = options.savedThreadIds;

    this.windowState = new WindowStateRegistry();
    this.layoutContext = new LayoutContext(this.windowState, this.windowState.handleMap);
    const cachePath = join(getConfigDir(), 'reload-cache', `${sessionId}.json`);
    this.reloadCache = new ReloadCache(cachePath);

    // Use the session logger created at startup
    this.sessionLogger = options.sessionLogger ?? null;

    // Restore windows from previous session
    if (options.restoreActions && options.restoreActions.length > 0) {
      this.windowState.restoreFromActions(options.restoreActions);
    }

    // Subscribe to action emitter for window state tracking and budget recording.
    // All actions emitted by agents in this session will be tracked.
    this.unsubscribeAction = actionEmitter.onAction((event) => {
      this.windowState.handleAction(event.action, event.monitorId);
      // Record action against the monitor's budget (if monitorId present)
      if (event.monitorId && this.pool) {
        this.pool.recordMonitorAction(event.monitorId);
      }
      // Wake iframe apps subscribed to yaar://windows (see http/subscriptions.ts).
      // The window is gone by now for window.close, so resolve() falls back to the
      // raw id — subscribers on the `yaar://windows` prefix match either form.
      if (event.action.type.startsWith('window.')) {
        const rawId = (event.action as { windowId?: string }).windowId;
        if (rawId) {
          const handle = this.windowState.handleMap.resolve(rawId) ?? rawId;
          subscriptionRegistry.notifyChange(`yaar://windows/${handle}`, this.sessionId);
        }
      }
      // Notify window subscribers of state changes
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
      // ToolActionBridge to broadcast them to the frontend. Detect these by checking
      // if the agentId starts with "iframe:" and broadcast directly.
      if (event.agentId?.startsWith('iframe:')) {
        const action = event.action;
        const raw = (action as { windowId?: string }).windowId;
        // Stamp the scoped handle if the action has a raw windowId
        const handle = raw ? (this.windowState.handleMap.resolve(raw) ?? raw) : undefined;
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
    });

    // Subscribe to app protocol requests from tools
    this.appProtocolListener = (data: {
      requestId: string;
      windowId: string;
      request: AppProtocolRequest;
      timeoutMs?: number;
    }) => {
      this.broadcast({
        type: ServerEventType.APP_PROTOCOL_REQUEST,
        requestId: data.requestId,
        windowId: data.windowId,
        request: data.request,
        timeoutMs: data.timeoutMs,
      });
    };
    actionEmitter.on('app-protocol', this.appProtocolListener);

    // The real browser reporting something nobody asked for (a native dialog fired, a driven tab
    // navigated). The frame arrives on a process-global socket with no session on it, so every
    // LiveSession hears it and decides for itself whether it has a window that cares.
    this.bridgeEventListener = (data: { channel: string; payload: unknown }) => {
      this.routeBridgeEvent(data.channel, data.payload);
    };
    actionEmitter.on('bridge-event', this.bridgeEventListener);

    // Subscribe to session-scoped event channels (approval requests, user prompts, verb subscriptions)
    this.unsubscribeSessionChannels = subscribeSessionChannels(
      sessionId,
      this.broadcast.bind(this),
      [
        'approval-request',
        'user-prompt',
        // Actions the server sends on its own behalf, outside any agent turn — a dialog
        // whose deadline passed being taken off the screen. There is no monitor context
        // on a timer callback, and a dialog is session-scoped anyway.
        'session-action',
        'verb-subscription',
        'desktop-shortcut',
        'browser-action',
      ],
    );
  }

  // ── Connection management ───────────────────────────────────────────

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

  getConnectionCount(): number {
    return this.connections.size;
  }

  /**
   * Deliver an unsolicited real-browser event to this session's Real Browser windows.
   *
   * This is the server-side twin of the `APP_EVENT` client frame: both land on
   * `ContextPool.notifyAppChannel`, so channel subscriptions, debounce, the per-window rate cap and
   * the `<app:event>` framing are shared. The event does *not* detour through the iframe to be
   * re-emitted via `app.emit()` — it already arrives in canonical form, the iframe would add nothing
   * but two hops, and a window mid-reload would silently drop it.
   *
   * A session with no Real Browser window open is not an error: the channels are declared on that
   * window, so with no window there is nobody who could have subscribed. Drop it.
   */
  private routeBridgeEvent(channel: string, payload: unknown): void {
    const pool = this.pool;
    if (!pool) return;

    for (const window of this.windowState.listWindows()) {
      if (window.appId !== BRIDGE_APP_ID) continue;
      pool.notifyAppChannel(window.id, channel, payload);
    }
  }

  // ── Event broadcasting ──────────────────────────────────────────────

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
    if (monitorId) {
      bc.publishToMonitor(this.sessionId, monitorId, event);
    } else {
      bc.publishToSession(this.sessionId, event);
    }
  }

  /**
   * Everything this session currently holds — and, by omission, everything it does not.
   *
   * Built on demand, when the client asks (`RESYNC`), rather than pushed at attach. The
   * client asks only after flushing what *it* was holding, so by the time this runs the
   * registries have heard about the window the user opened while the socket was down. A
   * snapshot taken any earlier would report that window as nonexistent and the client,
   * treating this as authoritative, would dutifully delete it.
   */
  async buildSnapshot(): Promise<{ actions: OSAction[]; agents: ActiveAgentSnapshot[] }> {
    const windows = await this.generateSnapshot();
    const agents = (this.pool?.listAgents() ?? [])
      .filter((a) => a.busy)
      .map((a) => ({
        agentId: a.id,
        status: a.label,
        ...(a.monitorId ? { monitorId: a.monitorId } : {}),
      }));
    return { actions: [...windows, ...this.surfaces.snapshot()], agents };
  }

  /**
   * Tell the user that the thing they just answered had already stopped listening.
   *
   * A dialog or prompt whose deadline passed is taken off the screen, but a click can
   * already be in flight when it goes — and the server has no id to match it to any more.
   * That click used to be dropped without a word, which reads, from the user's side, as
   * the system ignoring them.
   */
  private notifyTooLate(message: string): void {
    this.broadcast({
      type: ServerEventType.ACTIONS,
      actions: [
        {
          type: 'toast.show',
          id: `too-late-${Date.now()}`,
          message,
          variant: 'warning',
        },
      ],
      agentId: 'system',
    } as ServerEvent);
  }

  /**
   * Send an event to a specific connection only (e.g., initial snapshot).
   */
  sendTo(connectionId: ConnectionId, event: ServerEvent): void {
    getBroadcastCenter().publishToConnection(event, connectionId);
  }

  // ── Session Logger ──────────────────────────────────────────────────

  /**
   * Get the session logger (pool's logger takes precedence if available).
   */
  getSessionLogger(): SessionLogger | null {
    return this.pool?.getSessionLogger() ?? this.sessionLogger;
  }

  // ── Snapshot ────────────────────────────────────────────────────────

  /**
   * Generate a snapshot of current windows as window.create actions.
   * Used when a new connection joins an existing session.
   * Generates fresh iframe tokens for iframe windows.
   */
  async generateSnapshot(): Promise<OSAction[]> {
    const windows = this.windowState.listWindows();
    const actions: OSAction[] = windows.map((win) => ({
      type: 'window.create' as const,
      windowId: win.id,
      title: win.title,
      bounds: { ...win.bounds },
      content: { ...win.content },
      ...(win.variant ? { variant: win.variant } : {}),
      ...(win.dockEdge ? { dockEdge: win.dockEdge } : {}),
      ...(win.frameless ? { frameless: win.frameless } : {}),
      ...(win.windowStyle ? { windowStyle: win.windowStyle } : {}),
      ...(win.minimized ? { minimized: win.minimized } : {}),
      ...(win.appId ? { appId: win.appId } : {}),
    }));
    return refreshIframeTokens(actions, this.sessionId);
  }

  // ── Launch hooks ──────────────────────────────────────────────────

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
          const messageId = `hook-${hook.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          await this.routeMessage(
            { type: ClientEventType.USER_MESSAGE, content: hook.action.payload, messageId },
            connectionId,
          );
        } else if (hook.action.type === 'os_action') {
          const action = hook.action.payload as OSAction;
          const hookLogger = this.getSessionLogger();
          if (action.type.startsWith('window.')) {
            this.windowState.handleAction(action, '0');
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
              monitorId: '0',
            });
          } else {
            hookLogger?.logAction(action);
            this.broadcast({
              type: ServerEventType.ACTIONS,
              actions: [action],
              monitorId: '0',
            });
          }
        }
      }
    } catch (err) {
      console.error('Failed to execute launch hooks:', err);
    }
  }

  // ── Pool lifecycle ──────────────────────────────────────────────────

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

    // Load reload cache from disk
    await this.reloadCache.load();

    this.pool = new ContextPool(
      this.sessionId,
      this.windowState,
      this.reloadCache,
      this.broadcast.bind(this),
      this.restoredContext,
      this.savedThreadIds,
    );

    // Chain window close handlers: reload cache invalidation + pool agent cleanup
    const pool = this.pool;
    const reloadCache = this.reloadCache;
    this.windowState.setOnWindowClose((wid, appId, monitorId) => {
      reloadCache.invalidateForWindow(wid);
      pool.handleWindowClose(wid, appId, monitorId);
      subscriptionRegistry.clearForWindow(wid);
    });

    // Pass the session-owned logger (if already created by early user interactions)
    // so the pool reuses the same log directory instead of creating a second one.
    const success = await this.pool.initialize(this.sessionLogger ?? undefined);
    this.initialized = success;
    return success;
  }

  /** Send the authoritative state of this session to one connection. */
  private async sendSnapshot(connectionId: ConnectionId): Promise<void> {
    const { actions, agents } = await this.buildSnapshot();
    this.sendTo(connectionId, { type: ServerEventType.SNAPSHOT, actions, agents });
  }

  /** Record a message id as taken, evicting the oldest once the set is full. */
  private rememberMessageId(messageId: string): void {
    if (this.acceptedMessageIds.size >= LiveSession.MAX_TRACKED_MESSAGE_IDS) {
      const oldest = this.acceptedMessageIds.values().next().value;
      if (oldest !== undefined) this.acceptedMessageIds.delete(oldest);
    }
    this.acceptedMessageIds.add(messageId);
  }

  // ── Message routing ─────────────────────────────────────────────────

  /**
   * Route incoming messages to the appropriate handler.
   * Absorbed from SessionManager.routeMessage().
   */
  async routeMessage(event: ClientEvent, connectionId: ConnectionId): Promise<void> {
    // Lazy initialize on first message that needs the pool
    if (
      !this.initialized &&
      (event.type === ClientEventType.USER_MESSAGE ||
        event.type === ClientEventType.WINDOW_MESSAGE ||
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

    switch (event.type) {
      case ClientEventType.RESYNC:
        await this.sendSnapshot(connectionId);
        break;

      case ClientEventType.USER_MESSAGE: {
        // A user message's monitor comes from the connection that sent it. The client
        // always knows which monitor it is on, so `?? '0'` only ever fired when
        // something upstream had lost it — and then answered with the wrong monitor
        // rather than saying so.
        const monitorId = event.monitorId;
        if (!monitorId) {
          this.sendTo(connectionId, {
            type: ServerEventType.ERROR,
            error:
              'Message rejected: no monitor. A user message must name the monitor it came from.',
            messageId: event.messageId,
          });
          break;
        }
        if (!this.monitors.some((m) => m.id === monitorId)) {
          this.sendTo(connectionId, {
            type: ServerEventType.ERROR,
            error: `Message rejected: monitor ${monitorId} does not exist in this session.`,
            messageId: event.messageId,
            monitorId,
          });
          break;
        }
        // A resend from the client's outbox for a message we already took. Ack it again so
        // the outbox lets go, and do not run it twice.
        if (this.acceptedMessageIds.has(event.messageId)) {
          this.sendTo(connectionId, {
            type: ServerEventType.MESSAGE_ACCEPTED,
            messageId: event.messageId,
            agentId: 'duplicate',
          });
          break;
        }
        this.rememberMessageId(event.messageId);

        // "Act as me" target (CLI-panel toggle): route to the session agent — the
        // user's deputy, the one principal that can drive the real browser.
        if (event.target === 'session') {
          await this.pool?.handleSessionTask({
            type: 'session',
            messageId: event.messageId,
            content: event.content,
            interactions: event.interactions,
            monitorId,
          });
          break;
        }
        // The monitor exists (checked above); its agent is created on first use.
        if (this.pool && !this.pool.hasMonitorAgent(monitorId)) {
          await this.pool.createMonitorAgent(monitorId);
        }
        await this.pool?.handleTask({
          type: 'monitor',
          messageId: event.messageId,
          content: event.content,
          interactions: event.interactions,
          monitorId,
        });
        break;
      }

      case ClientEventType.WINDOW_MESSAGE:
        await this.pool?.handleTask({
          type: 'app',
          messageId: event.messageId,
          windowId: event.windowId,
          content: event.content,
        });
        break;

      case ClientEventType.COMPONENT_ACTION: {
        const windowContext = event.windowTitle
          ? `in window "${event.windowTitle}"`
          : `in window ${event.windowId}`;

        let content = `<ui:click>button "${event.action}" ${windowContext}</ui:click>`;

        if (event.componentPath && event.componentPath.length > 0) {
          content += `\nComponent path: ${event.componentPath.join(' → ')}`;
        }

        if (event.formData && event.formId) {
          content += `\n\nForm data (${event.formId}):\n${JSON.stringify(event.formData, null, 2)}`;
        }

        await this.pool?.handleTask({
          type: 'app',
          messageId:
            event.actionId ?? `component-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          windowId: event.windowId,
          content,
          actionId: event.actionId,
        });
        // Notify other agents subscribed to this window's interactions
        this.pool?.notifyWindowSubscribers(
          event.windowId,
          'interaction',
          `User clicked "${event.action}" ${windowContext}`,
          undefined, // no source agent — this is a user interaction
        );
        break;
      }

      case ClientEventType.INTERRUPT:
        await this.pool?.interruptAll();
        break;

      case ClientEventType.RESET:
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
        // Re-execute launch hooks (e.g., reopen dock)
        this.launchHooksExecuted = false;
        await this.executeLaunchHooks(connectionId);
        break;

      case ClientEventType.INTERRUPT_AGENT:
        await this.pool?.interruptAgent(event.agentId);
        break;

      case ClientEventType.SET_PROVIDER:
        await this.pool?.getPrimaryAgent()?.setProvider(event.provider);
        break;

      case ClientEventType.RENDERING_FEEDBACK:
        // Resolve directly via actionEmitter — the pending request is global (keyed by requestId),
        // so routing through a specific agent is unnecessary and fragile.
        actionEmitter.resolveFeedback({
          requestId: event.requestId,
          windowId: event.windowId,
          renderer: event.renderer,
          success: event.success,
          error: event.error,
          url: event.url,
          locked: event.locked,
          imageData: event.imageData,
        });
        break;

      case ClientEventType.DIALOG_FEEDBACK: {
        // Answered, so it is no longer on the screen — and must not be put back on it by
        // the next snapshot.
        this.surfaces.answered(event.dialogId);
        const resolved = await actionEmitter.resolveDialogFeedback({
          dialogId: event.dialogId,
          confirmed: event.confirmed,
          rememberChoice: event.rememberChoice,
        });
        // The answer arrived for a dialog whose deadline had already passed. The request
        // it was answering is gone — that cannot be undone — but the user is owed the
        // fact, instead of a click that lands on nothing. A remembered choice, unlike the
        // answer, still counts, and resolveDialogFeedback has already saved it.
        if (!resolved) {
          this.notifyTooLate(
            event.rememberChoice && event.rememberChoice !== 'once'
              ? 'That request timed out before you answered, so it was denied. Your choice was saved and will apply next time.'
              : 'That request timed out before you answered, so it was denied.',
          );
        }
        break;
      }

      case ClientEventType.APP_PROTOCOL_RESPONSE:
        actionEmitter.resolveAppProtocolResponse(event.requestId, event.response);
        break;

      case ClientEventType.APP_PROTOCOL_READY: {
        // The frontend reports the monitor-scoped key (e.g. "0/ai-chat", from the window
        // element's data-window-id). Keep that scope: readiness is per window, and the raw
        // AI-facing id ("ai-chat") names one window *per monitor*, so collapsing to it would
        // let monitor 0's registration mark monitor 1's window ready — leaving monitor 1's
        // agent talking to an iframe that never registered. app_query/app_command wait on
        // the same resolved key (see requireAppReady).
        //
        // Windows stored under a bare raw id (devtools preview windows, created via the
        // iframe-SDK proxy with no monitor) still resolve: getWindow() matches them exactly,
        // and the fallback below strips a scope they never had.
        const windowKey =
          this.windowState.getWindow(event.windowId)?.id ??
          this.windowState.handleMap.getRawWindowId(event.windowId);
        const wasReady = this.windowState.getWindow(windowKey)?.appProtocol ?? false;
        dbgLine(
          `READY event.windowId=${event.windowId} → key=${windowKey} session=${this.sessionId}`,
        );
        this.windowState.setAppProtocol(windowKey);
        actionEmitter.notifyAppReady(windowKey);
        // Replay stored commands only on re-registration (reload/remount), not first time
        if (wasReady) {
          this.replayAppCommands(windowKey);
        }
        break;
      }

      case ClientEventType.APP_EVENT: {
        // An app emitted on a declared channel. Pass the monitor-scoped window key
        // (from the iframe element's data-window-id) through as-is — ContextPool
        // indexes subscriptions by that key. Collapsing it to the raw AI-facing id
        // would deliver monitor 1's app events to a subscriber watching monitor 0's
        // copy of the same app, since both windows share the raw id.
        recordEmit(event.windowId, event.channel, event.payload);
        this.pool?.notifyAppChannel(event.windowId, event.channel, event.payload);
        break;
      }

      case ClientEventType.TOAST_ACTION:
        this.reloadCache.markFailed(event.eventId);
        console.log(
          `[LiveSession] Reload cache entry "${event.eventId}" reported as failed by user`,
        );
        break;

      case ClientEventType.USER_PROMPT_RESPONSE: {
        this.surfaces.answered(event.promptId);
        const resolved = actionEmitter.resolveUserPromptFeedback({
          promptId: event.promptId,
          selectedValues: event.selectedValues,
          text: event.text,
          dismissed: event.dismissed,
        });
        // Answered after the agent stopped waiting. Silently dropping it left the user
        // believing they had replied.
        if (!resolved && !event.dismissed) {
          this.notifyTooLate(
            'That prompt expired before you answered, so your answer was not sent.',
          );
        }
        break;
      }

      case ClientEventType.USER_INTERACTION: {
        const logger = this.getSessionLogger();

        for (const interaction of event.interactions) {
          logger?.logInteraction(interaction);

          switch (interaction.type) {
            case 'window.create':
              if (interaction.windowId && interaction.content && interaction.bounds) {
                const appMeta = interaction.appId ? await getAppMeta(interaction.appId) : null;
                const createAction = {
                  type: 'window.create' as const,
                  windowId: interaction.windowId,
                  title: interaction.windowTitle ?? interaction.windowId,
                  bounds: interaction.bounds,
                  content: interaction.content,
                  variant: appMeta?.variant,
                  dockEdge: appMeta?.dockEdge,
                  frameless: appMeta?.frameless,
                  windowStyle: appMeta?.windowStyle,
                  appId: interaction.appId,
                };
                // Reading a log, not routing a message: an interaction recorded before
                // monitors were stamped genuinely has no monitor, and the alternative to
                // placing it on the default desktop is dropping the user's window.
                this.windowState.handleAction(
                  createAction,
                  interaction.monitorId ?? DEFAULT_MONITOR_ID,
                );
                logger?.logAction(createAction);
              }
              break;
            case 'window.close':
              if (interaction.windowId) {
                this.windowState.handleAction({
                  type: 'window.close',
                  windowId: interaction.windowId,
                });
                // Close all browser sessions (including stale ones) when any browser window is
                // closed — both the headless sandbox and the user's real-Chrome (session) door.
                if (interaction.windowId.startsWith('browser-')) {
                  getHeadlessBrowser()
                    .closeAll()
                    .catch(() => {});
                  getLocalBrowser()
                    .closeAll()
                    .catch(() => {});
                }
              }
              break;
            case 'window.move':
            case 'window.resize':
              if (interaction.windowId && interaction.bounds) {
                const b = interaction.bounds;
                const moveAction = {
                  type: 'window.move' as const,
                  windowId: interaction.windowId,
                  x: b.x,
                  y: b.y,
                };
                const resizeAction = {
                  type: 'window.resize' as const,
                  windowId: interaction.windowId,
                  w: b.w,
                  h: b.h,
                };
                this.windowState.handleAction(moveAction);
                this.windowState.handleAction(resizeAction);
              }
              break;
          }
        }

        // If all windows are now closed, also close any hidden browser sessions
        // (e.g. sessions created with visible: false that have no window)
        if (
          event.interactions.some((i) => i.type === 'window.close') &&
          this.windowState.listWindows().length === 0
        ) {
          getHeadlessBrowser()
            .closeAll()
            .catch(() => {});
          getLocalBrowser()
            .closeAll()
            .catch(() => {});
        }

        this.pool?.pushUserInteractions(event.interactions);
        break;
      }

      case ClientEventType.SUBSCRIBE_MONITOR:
        // Where this *connection* is looking. Replaces whatever it was looking at
        // before — a tab watches one monitor at a time.
        getBroadcastCenter().subscribeToMonitor(connectionId, event.monitorId);
        if (event.viewport) {
          this.layoutContext.setViewport(event.monitorId, event.viewport);
        }
        break;

      case ClientEventType.ADD_MONITOR: {
        const monitor = this.addMonitor();
        if (!monitor) {
          this.sendTo(connectionId, {
            type: ServerEventType.ERROR,
            error: `Monitor limit reached (${MAX_MONITORS}).`,
          });
          break;
        }
        // Everyone gets the new list; only the tab that asked is told to go there.
        this.broadcast({ type: ServerEventType.MONITORS, monitors: this.getMonitors() });
        this.sendTo(connectionId, {
          type: ServerEventType.MONITORS,
          monitors: this.getMonitors(),
          focus: monitor.id,
        });
        break;
      }

      case ClientEventType.REMOVE_MONITOR:
        this.removeMonitor(event.monitorId);
        break;
    }
  }

  // ── Monitors ────────────────────────────────────────────────────────

  /** The session's monitors. Authoritative — the client renders this, it does not mint it. */
  getMonitors(): MonitorInfo[] {
    return this.monitors.map((m) => ({ ...m }));
  }

  /**
   * Mint a monitor, or null if the session is full.
   *
   * The id is the lowest non-negative integer not in use, so a session that has churned
   * monitors reuses the gaps rather than counting forever — and, unlike a per-tab
   * counter, two tabs asking at once get two different monitors.
   */
  private addMonitor(): MonitorInfo | null {
    if (this.monitors.length >= MAX_MONITORS) return null;
    const taken = new Set(this.monitors.map((m) => m.id));
    let n = 0;
    while (taken.has(String(n))) n++;
    const monitor: MonitorInfo = { id: String(n), label: `Monitor ${n + 1}` };
    this.monitors.push(monitor);
    return monitor;
  }

  /**
   * Delete a monitor: its agent, its subscribers, and its place in the list.
   *
   * Removing the agent used to be the whole of it — the connections watching the monitor
   * stayed subscribed, so a deleted desktop kept delivering events and the frontend
   * dutifully re-created its windows. Detaching the subscribers is what makes the
   * deletion mean anything.
   */
  private removeMonitor(monitorId: string): void {
    if (monitorId === DEFAULT_MONITOR_ID) return; // the session always has monitor 0
    if (!this.monitors.some((m) => m.id === monitorId)) return;

    this.monitors = this.monitors.filter((m) => m.id !== monitorId);
    getBroadcastCenter().unsubscribeMonitor(this.sessionId, monitorId);

    this.pool?.removeMonitorAgent(monitorId).catch((err) => {
      console.error(
        `[LiveSession ${this.sessionId}] Failed to remove monitor agent for ${monitorId}:`,
        err,
      );
    });

    this.broadcast({ type: ServerEventType.MONITORS, monitors: this.getMonitors() });
  }

  // ── App protocol replay ─────────────────────────────────────────────

  /**
   * Replay stored app commands to a window that just re-registered.
   * This restores iframe app state after reload or remount.
   */
  private replayAppCommands(windowId: string): void {
    const commands = this.windowState.getAppCommands(windowId);
    if (commands.length === 0) return;

    console.log(
      `[LiveSession ${this.sessionId}] Replaying ${commands.length} app commands to window ${windowId}`,
    );
    for (let i = 0; i < commands.length; i++) {
      this.broadcast({
        type: ServerEventType.APP_PROTOCOL_REQUEST,
        requestId: `replay-${windowId}-${Date.now()}-${i}`,
        windowId,
        request: commands[i],
      });
    }
  }

  // ── Query methods ───────────────────────────────────────────────────

  hasWindow(windowId: string): boolean {
    return this.windowState.hasWindow(windowId);
  }

  getPool(): ContextPool | null {
    return this.pool;
  }

  // ── Cleanup ─────────────────────────────────────────────────────────

  async cleanup(): Promise<void> {
    if (this.unsubscribeAction) {
      this.unsubscribeAction();
      this.unsubscribeAction = null;
    }
    if (this.appProtocolListener) {
      actionEmitter.off('app-protocol', this.appProtocolListener);
      this.appProtocolListener = null;
    }
    if (this.bridgeEventListener) {
      actionEmitter.off('bridge-event', this.bridgeEventListener);
      this.bridgeEventListener = null;
    }
    if (this.unsubscribeSessionChannels) {
      this.unsubscribeSessionChannels();
      this.unsubscribeSessionChannels = null;
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
