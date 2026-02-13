/**
 * LiveSession - Session-scoped container for multi-client support.
 *
 * A LiveSession owns all state for one logical session:
 * - ContextPool (agents, task routing)
 * - WindowStateRegistry (server-side window state)
 * - ReloadCache (fingerprint-based action caching)
 * - EventSequencer (monotonic seq for replay)
 *
 * Multiple WebSocket connections can join the same LiveSession.
 * The session survives individual disconnects; only destroyed when
 * all connections leave (or explicit reset).
 */

import { join } from 'path';
import { ContextPool } from '../agents/context-pool.js';
import type { ContextMessage } from '../agents/context.js';
import { WindowStateRegistry } from '../mcp/window-state.js';
import { ReloadCache } from '../reload/cache.js';
import { EventSequencer } from './event-sequencer.js';
import type { SessionId } from './types.js';
import { generateSessionId } from './types.js';
import type { ConnectionId } from './broadcast-center.js';
import { getBroadcastCenter } from './broadcast-center.js';
import type { ClientEvent, ServerEvent, OSAction, AppProtocolRequest } from '@yaar/shared';
import type { WebSocket } from 'ws';
import { actionEmitter } from '../mcp/action-emitter.js';
import { getConfigDir } from '../storage/storage-manager.js';
import { getWarmPool } from '../providers/warm-pool.js';

export interface LiveSessionOptions {
  restoreActions?: OSAction[];
  contextMessages?: ContextMessage[];
  savedThreadIds?: Record<string, string>;
}

export class LiveSession {
  readonly sessionId: SessionId;
  private connections = new Map<ConnectionId, WebSocket>();

  // Session-scoped state
  private pool: ContextPool | null = null;
  private initPromise: Promise<boolean> | null = null;
  private initialized = false;
  readonly windowState: WindowStateRegistry;
  readonly reloadCache: ReloadCache;
  private sequencer: EventSequencer;

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

  constructor(sessionId: SessionId, options: LiveSessionOptions = {}) {
    this.sessionId = sessionId;
    this.restoredContext = options.contextMessages ?? [];
    this.savedThreadIds = options.savedThreadIds;

    this.windowState = new WindowStateRegistry();
    const cachePath = join(getConfigDir(), 'reload-cache', `${sessionId}.json`);
    this.reloadCache = new ReloadCache(cachePath);
    this.sequencer = new EventSequencer();

    // Restore windows from previous session
    if (options.restoreActions && options.restoreActions.length > 0) {
      this.windowState.restoreFromActions(options.restoreActions);
    }

    // Subscribe to action emitter for window state tracking and budget recording.
    // All actions emitted by agents in this session will be tracked.
    this.unsubscribeAction = actionEmitter.onAction((event) => {
      this.windowState.handleAction(event.action);
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
        type: 'APP_PROTOCOL_REQUEST',
        requestId: data.requestId,
        windowId: data.windowId,
        request: data.request,
      });
    };
    actionEmitter.on('app-protocol', this.appProtocolListener);
  }

  // ── Connection management ───────────────────────────────────────────

  addConnection(connectionId: ConnectionId, ws: WebSocket): void {
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
   * Broadcast an event to all connections in this session.
   * Stamps with monotonic sequence number.
   */
  broadcast(event: ServerEvent): void {
    const stamped = this.sequencer.stamp(event);
    const monitorId = (event as { monitorId?: string }).monitorId;
    const bc = getBroadcastCenter();
    if (monitorId) {
      bc.publishToMonitor(this.sessionId, monitorId, stamped);
    } else {
      bc.publishToSession(this.sessionId, stamped);
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
    }));
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
      this.restoredContext,
      this.savedThreadIds,
    );

    // Chain window close handlers: reload cache invalidation + pool agent cleanup
    const pool = this.pool;
    const reloadCache = this.reloadCache;
    this.windowState.setOnWindowClose((wid) => {
      reloadCache.invalidateForWindow(wid);
      pool.handleWindowClose(wid);
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
      (event.type === 'USER_MESSAGE' ||
        event.type === 'WINDOW_MESSAGE' ||
        event.type === 'COMPONENT_ACTION')
    ) {
      const success = await this.ensureInitialized();
      if (!success) {
        console.error(`[LiveSession ${this.sessionId}] Failed to initialize pool`);
        return;
      }
    }

    switch (event.type) {
      case 'USER_MESSAGE': {
        const monitorId = event.monitorId ?? 'monitor-0';
        // Auto-create monitor agent if needed (max 4 monitors)
        if (monitorId !== 'monitor-0' && this.pool && !this.pool.hasMainAgent(monitorId)) {
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

      case 'WINDOW_MESSAGE':
        await this.pool?.handleTask({
          type: 'window',
          messageId: event.messageId,
          windowId: event.windowId,
          content: event.content,
        });
        break;

      case 'COMPONENT_ACTION': {
        const windowContext = event.windowTitle
          ? `in window "${event.windowTitle}"`
          : `in window ${event.windowId}`;

        let content = `<user_interaction:click>button "${event.action}" ${windowContext}</user_interaction:click>`;

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

      case 'INTERRUPT':
        await this.pool?.interruptAll();
        break;

      case 'RESET':
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
        break;

      case 'INTERRUPT_AGENT':
        await this.pool?.interruptAgent(event.agentId);
        break;

      case 'SET_PROVIDER':
        await this.pool?.getPrimaryAgent()?.setProvider(event.provider);
        break;

      case 'RENDERING_FEEDBACK':
        this.pool
          ?.getPrimaryAgent()
          ?.handleRenderingFeedback(
            event.requestId,
            event.windowId,
            event.renderer,
            event.success,
            event.error,
            event.url,
            event.locked,
            event.imageData,
          );
        break;

      case 'DIALOG_FEEDBACK':
        actionEmitter.resolveDialogFeedback({
          dialogId: event.dialogId,
          confirmed: event.confirmed,
          rememberChoice: event.rememberChoice,
        });
        break;

      case 'APP_PROTOCOL_RESPONSE':
        actionEmitter.resolveAppProtocolResponse(event.requestId, event.response);
        break;

      case 'APP_PROTOCOL_READY': {
        const wasReady = this.windowState.getWindow(event.windowId)?.appProtocol ?? false;
        this.windowState.setAppProtocol(event.windowId);
        actionEmitter.notifyAppReady(event.windowId);
        // Replay stored commands only on re-registration (reload/remount), not first time
        if (wasReady) {
          this.replayAppCommands(event.windowId);
        }
        break;
      }

      case 'TOAST_ACTION':
        this.reloadCache.markFailed(event.eventId);
        console.log(
          `[LiveSession] Reload cache entry "${event.eventId}" reported as failed by user`,
        );
        break;

      case 'USER_INTERACTION': {
        const logger = this.pool?.getSessionLogger();

        for (const interaction of event.interactions) {
          await logger?.logInteraction(interaction);

          switch (interaction.type) {
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
                await logger?.logAction(moveAction);
                await logger?.logAction(resizeAction);
              }
              break;
          }
        }

        this.pool?.pushUserInteractions(event.interactions);
        break;
      }

      case 'SUBSCRIBE_MONITOR':
        getBroadcastCenter().subscribeToMonitor(connectionId, event.monitorId);
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
        type: 'APP_PROTOCOL_REQUEST',
        requestId: `replay-${windowId}-${Date.now()}-${i}`,
        windowId,
        request: commands[i],
      });
    }
  }

  // ── Query methods ───────────────────────────────────────────────────

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

    if (this.pool) {
      await this.pool.cleanup();
      this.pool = null;
    }

    this.windowState.clear();
    this.initialized = false;
  }
}

// ── SessionHub — singleton registry of live sessions ─────────────────

class SessionHub {
  private sessions = new Map<SessionId, LiveSession>();
  private defaultSessionId: SessionId | null = null;

  /**
   * Get an existing session or create a new one.
   * If requestedId matches an existing session, returns it.
   * Otherwise creates a new session with the provided options.
   */
  getOrCreate(requestedId: string | null, options: LiveSessionOptions): LiveSession {
    // Try to find existing session
    if (requestedId) {
      const existing = this.sessions.get(requestedId);
      if (existing) {
        return existing;
      }
    }

    // Return existing default session if one exists and no specific ID was requested
    if (!requestedId && this.defaultSessionId) {
      const existing = this.sessions.get(this.defaultSessionId);
      if (existing) {
        return existing;
      }
    }

    // Create new session
    const sessionId = requestedId ?? generateSessionId();
    const session = new LiveSession(sessionId, options);

    this.sessions.set(sessionId, session);
    if (!this.defaultSessionId) {
      this.defaultSessionId = sessionId;
    }

    console.log(`[SessionHub] Created session: ${sessionId}`);
    return session;
  }

  get(sessionId: SessionId): LiveSession | undefined {
    return this.sessions.get(sessionId);
  }

  getDefault(): LiveSession | undefined {
    if (this.defaultSessionId) {
      return this.sessions.get(this.defaultSessionId);
    }
    return undefined;
  }

  async remove(sessionId: SessionId): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      await session.cleanup();
      this.sessions.delete(sessionId);
      if (this.defaultSessionId === sessionId) {
        this.defaultSessionId = null;
      }
      console.log(`[SessionHub] Removed session: ${sessionId}`);
    }
  }
}

let hub: SessionHub | null = null;

export function getSessionHub(): SessionHub {
  if (!hub) {
    hub = new SessionHub();
  }
  return hub;
}

export function initSessionHub(): SessionHub {
  hub = new SessionHub();
  return hub;
}
