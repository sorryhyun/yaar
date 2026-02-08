/**
 * Session manager - manages the unified context pool for a WebSocket connection.
 *
 * Routes messages to the appropriate handler based on type:
 * - USER_MESSAGE: Main conversation (sequential)
 * - WINDOW_MESSAGE: Window-specific (parallel)
 */

import { ContextPool } from './context-pool.js';
import type { ContextMessage } from './context.js';
import type { ClientEvent } from '@yaar/shared';
import type { ConnectionId } from '../websocket/broadcast-center.js';
import { actionEmitter } from '../mcp/action-emitter.js';
import { reloadCacheManager } from '../reload/index.js';
import { windowStateRegistryManager } from '../mcp/window-state.js';

export class SessionManager {
  private connectionId: ConnectionId;
  private pool: ContextPool | null = null;
  private initPromise: Promise<boolean> | null = null;
  private initialized = false;
  private restoredContext: ContextMessage[];
  private savedThreadIds?: Record<string, string>;

  constructor(connectionId: ConnectionId, restoredContext: ContextMessage[] = [], savedThreadIds?: Record<string, string>) {
    this.connectionId = connectionId;
    this.restoredContext = restoredContext;
    this.savedThreadIds = savedThreadIds;
  }

  /**
   * Initialize the context pool.
   * This is now a no-op - actual initialization happens lazily on first message.
   */
  async initialize(): Promise<boolean> {
    // Just return true - actual init happens on first message
    return true;
  }

  /**
   * Ensure the pool is initialized (lazy initialization).
   */
  private async ensureInitialized(): Promise<boolean> {
    if (this.initialized) {
      return true;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.doInitialize();
    const result = await this.initPromise;
    this.initPromise = null;
    return result;
  }

  private async doInitialize(): Promise<boolean> {
    console.log(`[SessionManager] Lazy initializing pool for ${this.connectionId}`);
    // Mark as active so MCP tool handlers (which can't resolve the connection
    // ID from AsyncLocalStorage) fall back to the correct instances.
    windowStateRegistryManager.setActive(this.connectionId);
    const windowState = windowStateRegistryManager.get(this.connectionId);
    const reloadCache = await reloadCacheManager.ensureLoaded(this.connectionId);
    this.pool = new ContextPool(this.connectionId, windowState, reloadCache, this.restoredContext, this.savedThreadIds);

    // Chain both window close handlers: reload cache + pool agent cleanup
    const pool = this.pool;
    windowState.setOnWindowClose((wid) => {
      reloadCache.invalidateForWindow(wid);
      pool.handleWindowClose(wid);
    });
    const success = await this.pool.initialize();
    this.initialized = success;
    return success;
  }

  /**
   * Route incoming messages to the appropriate handler.
   */
  async routeMessage(event: ClientEvent): Promise<void> {
    // Lazy initialize on first message that needs the pool
    if (!this.initialized && (event.type === 'USER_MESSAGE' || event.type === 'WINDOW_MESSAGE' || event.type === 'COMPONENT_ACTION')) {
      const success = await this.ensureInitialized();
      if (!success) {
        console.error('[SessionManager] Failed to initialize pool');
        return;
      }
    }

    switch (event.type) {
      case 'USER_MESSAGE':
        await this.pool?.handleTask({
          type: 'main',
          messageId: event.messageId,
          content: event.content,
          interactions: event.interactions,
        });
        break;

      case 'WINDOW_MESSAGE':
        await this.pool?.handleTask({
          type: 'window',
          messageId: event.messageId,
          windowId: event.windowId,
          content: event.content,
        });
        break;

      case 'COMPONENT_ACTION': {
        // Route component action as a window task
        // If actionId is provided (parallel button), use it as the processing key

        // Format content with rich context about the interaction
        const windowContext = event.windowTitle
          ? `in window "${event.windowTitle}"`
          : `in window ${event.windowId}`;

        let content = `<user_interaction:click>button "${event.action}" ${windowContext}</user_interaction:click>`;

        // Add component path for context about where in the UI hierarchy the click occurred
        if (event.componentPath && event.componentPath.length > 0) {
          content += `\nComponent path: ${event.componentPath.join(' → ')}`;
        }

        // Add form data if present
        if (event.formData && event.formId) {
          content += `\n\nForm data (${event.formId}):\n${JSON.stringify(event.formData, null, 2)}`;
        }

        await this.pool?.handleTask({
          type: 'window',
          messageId: event.actionId ?? `component-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          windowId: event.windowId,
          content,
          actionId: event.actionId, // Pass through for parallel processing
        });
        break;
      }

      case 'INTERRUPT':
        // Interrupt all agents
        await this.pool?.interruptAll();
        break;

      case 'RESET':
        // Reset: interrupt all agents, clear context
        await this.pool?.reset();
        break;

      case 'INTERRUPT_AGENT':
        // Interrupt specific agent by ID
        await this.pool?.interruptAgent(event.agentId);
        break;

      case 'SET_PROVIDER':
        await this.pool?.getPrimaryAgent()?.setProvider(event.provider);
        break;

      case 'RENDERING_FEEDBACK':
        this.pool?.getPrimaryAgent()?.handleRenderingFeedback(
          event.requestId,
          event.windowId,
          event.renderer,
          event.success,
          event.error,
          event.url,
          event.locked,
          event.imageData
        );
        break;

      case 'DIALOG_FEEDBACK':
        actionEmitter.resolveDialogFeedback({
          dialogId: event.dialogId,
          confirmed: event.confirmed,
          rememberChoice: event.rememberChoice,
        });
        break;

      case 'TOAST_ACTION':
        reloadCacheManager.get(this.connectionId).markFailed(event.eventId);
        console.log(`[SessionManager] Reload cache entry "${event.eventId}" reported as failed by user`);
        break;

      case 'USER_INTERACTION': {
        const windowState = windowStateRegistryManager.get(this.connectionId);
        const logger = this.pool?.getSessionLogger();

        for (const interaction of event.interactions) {
          // Log to session
          await logger?.logInteraction(interaction);

          switch (interaction.type) {
            case 'window.close':
              if (interaction.windowId) {
                windowState.handleAction({ type: 'window.close', windowId: interaction.windowId });
              }
              break;
            case 'window.move':
            case 'window.resize':
              if (interaction.windowId && interaction.bounds) {
                const b = interaction.bounds;
                const moveAction = { type: 'window.move' as const, windowId: interaction.windowId, x: b.x, y: b.y };
                const resizeAction = { type: 'window.resize' as const, windowId: interaction.windowId, w: b.w, h: b.h };
                windowState.handleAction(moveAction);
                windowState.handleAction(resizeAction);
                await logger?.logAction(moveAction);
                await logger?.logAction(resizeAction);
              }
              break;
          }
        }

        // Accumulate in timeline for main agent's next turn
        this.pool?.pushUserInteractions(event.interactions);
        break;
      }
    }
  }

  /**
   * Check if a window has an active agent.
   */
  hasWindowAgent(windowId: string): boolean {
    return this.pool?.hasActiveAgent(windowId) ?? false;
  }

  /**
   * Get the agent ID for a window (if any).
   */
  getWindowAgentId(windowId: string): string | undefined {
    return this.pool?.getWindowAgentId(windowId);
  }

  /**
   * Get the context pool (for stats/debugging).
   */
  getPool(): ContextPool | null {
    return this.pool;
  }

  /**
   * Clean up all resources.
   */
  async cleanup(): Promise<void> {
    if (this.pool) {
      await this.pool.cleanup();
      this.pool = null;
    }
    windowStateRegistryManager.clear(this.connectionId);
    reloadCacheManager.clear(this.connectionId);
  }
}
