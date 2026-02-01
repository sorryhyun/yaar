/**
 * Session manager - manages the unified context pool for a WebSocket connection.
 *
 * Routes messages to the appropriate handler based on type:
 * - USER_MESSAGE: Main conversation (sequential)
 * - WINDOW_MESSAGE: Window-specific (parallel)
 */

import { ContextPool } from './context-pool.js';
import type { ClientEvent } from '@claudeos/shared';
import type { ConnectionId } from '../events/broadcast-center.js';
import { actionEmitter } from '../mcp/action-emitter.js';

export class SessionManager {
  private connectionId: ConnectionId;
  private pool: ContextPool | null = null;
  private initPromise: Promise<boolean> | null = null;
  private initialized = false;

  constructor(connectionId: ConnectionId) {
    this.connectionId = connectionId;
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
    this.pool = new ContextPool(this.connectionId);
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
          event.locked
        );
        break;

      case 'DIALOG_FEEDBACK':
        actionEmitter.resolveDialogFeedback({
          dialogId: event.dialogId,
          confirmed: event.confirmed,
          rememberChoice: event.rememberChoice,
        });
        break;
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
  }
}
