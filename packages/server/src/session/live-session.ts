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
import { ReloadCache } from '../reload/cache.js';
import type { SessionId } from './types.js';
import type { ConnectionId } from './broadcast-center.js';
import { getBroadcastCenter } from './broadcast-center.js';
import {
  ServerEventType,
  ClientEventType,
  type ClientEvent,
  type ServerEvent,
  type OSAction,
  type AppProtocolRequest,
} from '@yaar/shared';
import type { YaarWebSocket } from './types.js';
import { actionEmitter } from './action-emitter.js';
import { getConfigDir } from '../storage/storage-manager.js';
import { getWarmPool } from '../providers/warm-pool.js';
import { getHooksByEvent } from '../features/config/hooks.js';
import { subscriptionRegistry } from '../http/subscriptions.js';

export interface LiveSessionOptions {
  restoreActions?: OSAction[];
  contextMessages?: ContextMessage[];
  savedThreadIds?: Record<string, string>;
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
  private connections = new Map<ConnectionId, YaarWebSocket>();

  // Session-scoped state
  private pool: ContextPool | null = null;
  private initPromise: Promise<boolean> | null = null;
  private initialized = false;
  readonly windowState: WindowStateRegistry;
  readonly reloadCache: ReloadCache;

  // Restored state
  private restoredContext: ContextMessage[];
  private savedThreadIds?: Record<string, string>;

  /** True once launch hooks have been executed — prevents re-firing on reconnect or second tab. */
  launchHooksExecuted = false;

  // Action listener for window state tracking
  private unsubscribeAction: (() => void) | null = null;
  // App protocol listener for iframe communication
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private appProtocolListener: ((...args: any[]) => void) | null = null;
  // Session-scoped channel listeners (approval-request, user-prompt)
  private unsubscribeSessionChannels: (() => void) | null = null;

  constructor(sessionId: SessionId, options: LiveSessionOptions = {}) {
    this.sessionId = sessionId;
    this.restoredContext = options.contextMessages ?? [];
    this.savedThreadIds = options.savedThreadIds;

    this.windowState = new WindowStateRegistry();
    const cachePath = join(getConfigDir(), 'reload-cache', `${sessionId}.json`);
    this.reloadCache = new ReloadCache(cachePath);

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
    });

    // Subscribe to app protocol requests from tools
    this.appProtocolListener = (data: {
      requestId: string;
      windowId: string;
      request: AppProtocolRequest;
    }) => {
      this.broadcast({
        type: ServerEventType.APP_PROTOCOL_REQUEST,
        requestId: data.requestId,
        windowId: data.windowId,
        request: data.request,
      });
    };
    actionEmitter.on('app-protocol', this.appProtocolListener);

    // Subscribe to session-scoped event channels (approval requests, user prompts, verb subscriptions)
    this.unsubscribeSessionChannels = subscribeSessionChannels(
      sessionId,
      this.broadcast.bind(this),
      ['approval-request', 'user-prompt', 'verb-subscription'],
    );
  }

  // ── Connection management ───────────────────────────────────────────

  addConnection(connectionId: ConnectionId, ws: YaarWebSocket): void {
    this.connections.set(connectionId, ws);
    console.log(
      `[LiveSession ${this.sessionId}] Connection added: ${connectionId} (total: ${this.connections.size})`,
    );
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
    const monitorId = (event as { monitorId?: string }).monitorId;
    const bc = getBroadcastCenter();
    if (monitorId) {
      bc.publishToMonitor(this.sessionId, monitorId, event);
    } else {
      bc.publishToSession(this.sessionId, event);
    }
  }

  /**
   * Send an event to a specific connection only (e.g., initial snapshot).
   */
  sendTo(connectionId: ConnectionId, event: ServerEvent): void {
    getBroadcastCenter().publishToConnection(event, connectionId);
  }

  // ── Snapshot ────────────────────────────────────────────────────────

  /**
   * Generate a snapshot of current windows as window.create actions.
   * Used when a new connection joins an existing session.
   */
  generateSnapshot(): OSAction[] {
    const windows = this.windowState.listWindows();
    return windows.map((win) => ({
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
    }));
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
          if (action.type.startsWith('window.')) {
            this.windowState.handleAction(action, '0');
          }
          this.broadcast({
            type: ServerEventType.ACTIONS,
            actions: [action],
            monitorId: '0',
          });
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
    this.windowState.setOnWindowClose((wid) => {
      reloadCache.invalidateForWindow(wid);
      pool.handleWindowClose(wid);
      subscriptionRegistry.clearForWindow(wid);
    });

    const success = await this.pool.initialize();
    this.initialized = success;
    return success;
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
        console.error(`[LiveSession ${this.sessionId}] Failed to initialize pool`);
        return;
      }
    }

    switch (event.type) {
      case ClientEventType.USER_MESSAGE: {
        const monitorId = event.monitorId ?? '0';
        // Auto-create monitor agent if needed (max 4 monitors)
        if (monitorId !== '0' && this.pool && !this.pool.hasMainAgent(monitorId)) {
          if (this.pool.getMainAgentCount() >= 4) {
            console.warn(
              `[LiveSession ${this.sessionId}] Monitor limit reached (4), ignoring ${monitorId}`,
            );
            break;
          }
          await this.pool.createMonitorAgent(monitorId);
        }
        await this.pool?.handleTask({
          type: 'main',
          messageId: event.messageId,
          content: event.content,
          interactions: event.interactions,
          monitorId,
        });
        break;
      }

      case ClientEventType.WINDOW_MESSAGE:
        await this.pool?.handleTask({
          type: 'window',
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
          type: 'window',
          messageId:
            event.actionId ?? `component-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          windowId: event.windowId,
          content,
          actionId: event.actionId,
        });
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

      case ClientEventType.DIALOG_FEEDBACK:
        actionEmitter.resolveDialogFeedback({
          dialogId: event.dialogId,
          confirmed: event.confirmed,
          rememberChoice: event.rememberChoice,
        });
        break;

      case ClientEventType.APP_PROTOCOL_RESPONSE:
        actionEmitter.resolveAppProtocolResponse(event.requestId, event.response);
        break;

      case ClientEventType.APP_PROTOCOL_READY: {
        const wasReady = this.windowState.getWindow(event.windowId)?.appProtocol ?? false;
        this.windowState.setAppProtocol(event.windowId);
        actionEmitter.notifyAppReady(event.windowId);
        // Replay stored commands only on re-registration (reload/remount), not first time
        if (wasReady) {
          this.replayAppCommands(event.windowId);
        }
        break;
      }

      case ClientEventType.TOAST_ACTION:
        this.reloadCache.markFailed(event.eventId);
        console.log(
          `[LiveSession] Reload cache entry "${event.eventId}" reported as failed by user`,
        );
        break;

      case ClientEventType.USER_PROMPT_RESPONSE:
        actionEmitter.resolveUserPromptFeedback({
          promptId: event.promptId,
          selectedValues: event.selectedValues,
          text: event.text,
          dismissed: event.dismissed,
        });
        break;

      case ClientEventType.USER_INTERACTION: {
        const logger = this.pool?.getSessionLogger();

        for (const interaction of event.interactions) {
          logger?.logInteraction(interaction);

          switch (interaction.type) {
            case 'window.create':
              if (interaction.windowId && interaction.content && interaction.bounds) {
                const createAction = {
                  type: 'window.create' as const,
                  windowId: interaction.windowId,
                  title: interaction.windowTitle ?? interaction.windowId,
                  bounds: interaction.bounds,
                  content: interaction.content,
                  variant: interaction.variant as 'standard' | 'widget' | 'panel' | undefined,
                  dockEdge: interaction.dockEdge as 'top' | 'bottom' | undefined,
                  frameless: interaction.frameless,
                  windowStyle: interaction.windowStyle,
                };
                this.windowState.handleAction(createAction, interaction.monitorId ?? '0');
                logger?.logAction(createAction);
              }
              break;
            case 'window.close':
              if (interaction.windowId) {
                this.windowState.handleAction({
                  type: 'window.close',
                  windowId: interaction.windowId,
                });
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
                logger?.logAction(moveAction);
                logger?.logAction(resizeAction);
              }
              break;
          }
        }

        this.pool?.pushUserInteractions(event.interactions);
        break;
      }

      case ClientEventType.SUBSCRIBE_MONITOR:
        getBroadcastCenter().subscribeToMonitor(connectionId, event.monitorId);
        break;

      case ClientEventType.REMOVE_MONITOR:
        if (this.pool) {
          this.pool.removeMonitorAgent(event.monitorId).catch((err) => {
            console.error(
              `[LiveSession ${this.sessionId}] Failed to remove monitor agent for ${event.monitorId}:`,
              err,
            );
          });
        }
        break;
    }
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
    if (this.unsubscribeSessionChannels) {
      this.unsubscribeSessionChannels();
      this.unsubscribeSessionChannels = null;
    }

    // Force-clear any pending requests/dialogs/app-requests for this session
    // so awaiting tools unblock immediately instead of waiting for timeouts.
    actionEmitter.clearPendingForSession(this.sessionId);

    // Flush buffered session logs before tearing down the pool
    await this.pool?.getSessionLogger()?.dispose();

    if (this.pool) {
      await this.pool.cleanup();
      this.pool = null;
    }

    subscriptionRegistry.clearForSession(this.sessionId);
    this.windowState.clear();
    this.initialized = false;
  }
}
