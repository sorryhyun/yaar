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

export class SessionManager {
  private connectionId: ConnectionId;
  private pool: ContextPool | null = null;

  constructor(connectionId: ConnectionId) {
    this.connectionId = connectionId;
  }

  /**
   * Initialize the context pool.
   */
  async initialize(): Promise<boolean> {
    this.pool = new ContextPool(this.connectionId);
    return await this.pool.initialize();
  }

  /**
   * Route incoming messages to the appropriate handler.
   */
  async routeMessage(event: ClientEvent): Promise<void> {
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

        let content = `User clicked button "${event.action}" ${windowContext}`;

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
