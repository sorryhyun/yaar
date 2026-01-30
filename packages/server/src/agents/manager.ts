/**
 * Session manager - manages multiple agent sessions per WebSocket connection.
 *
 * Agent types:
 * - Default agent pool: Pool of agents for handling concurrent user messages
 * - Window agent pool: Shared pool for parallel window message handling
 * - Subagent: Spawned by default/window agents via SDK native feature
 */

import { DefaultAgentPool } from './default-pool.js';
import { WindowAgentPool } from './window-pool.js';
import type { ClientEvent, ServerEvent } from '@claudeos/shared';
import { getBroadcastCenter, type ConnectionId } from '../events/broadcast-center.js';

export class SessionManager {
  private connectionId: ConnectionId;
  private defaultPool: DefaultAgentPool | null = null;
  private windowPool: WindowAgentPool | null = null;

  constructor(connectionId: ConnectionId) {
    this.connectionId = connectionId;
  }

  /**
   * Initialize the main session pool and window pool.
   */
  async initialize(): Promise<boolean> {
    this.defaultPool = new DefaultAgentPool(this.connectionId);
    const success = await this.defaultPool.initialize();

    if (success) {
      // Initialize window pool with shared logger and base session from default pool
      this.windowPool = new WindowAgentPool(
        this.connectionId,
        this.defaultPool.getSessionLogger() ?? undefined,
        () => this.defaultPool?.getBaseSessionId() ?? undefined
      );
    }

    return success;
  }

  /**
   * Route incoming messages to the appropriate session.
   */
  async routeMessage(event: ClientEvent): Promise<void> {
    switch (event.type) {
      case 'USER_MESSAGE':
        // Route to pool which handles concurrent messages
        await this.defaultPool?.handleMessage(event.messageId, event.content, event.interactions);
        break;

      case 'WINDOW_MESSAGE':
        // Window messages are now handled by the window pool in parallel
        await this.windowPool?.handleMessage(
          event.messageId,
          event.windowId,
          event.content
        );
        break;

      case 'COMPONENT_ACTION':
        // Route component action to window pool
        await this.windowPool?.handleComponentAction(event.windowId, event.action);
        break;

      case 'INTERRUPT':
        // Interrupt all agents in the pool
        await this.defaultPool?.interruptAll();
        break;

      case 'INTERRUPT_AGENT':
        // Interrupt specific agent by ID
        await this.interruptAgent(event.agentId);
        break;

      case 'SET_PROVIDER':
        await this.defaultPool?.getPrimaryAgent()?.setProvider(event.provider);
        break;

      case 'RENDERING_FEEDBACK':
        // Rendering feedback goes to primary session (action emitter handles it)
        this.defaultPool?.getPrimaryAgent()?.handleRenderingFeedback(
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
   * Interrupt a specific agent by ID.
   */
  private async interruptAgent(agentId: string): Promise<void> {
    if (agentId === 'default') {
      await this.defaultPool?.interruptAll();
      return;
    }

    // Try to interrupt window agent
    const interrupted = await this.windowPool?.interruptAgent(agentId);
    if (!interrupted) {
      console.warn(`[SessionManager] Could not find agent to interrupt: ${agentId}`);
    }
  }

  /**
   * Check if a window has an active agent.
   */
  hasWindowAgent(windowId: string): boolean {
    return this.windowPool?.hasActiveAgent(windowId) ?? false;
  }

  /**
   * Get the agent ID for a window (if any).
   */
  getWindowAgentId(windowId: string): string | undefined {
    return this.windowPool?.getWindowAgentId(windowId);
  }

  /**
   * Send an event to the client via broadcast center.
   */
  private async sendEvent(event: ServerEvent): Promise<void> {
    getBroadcastCenter().publishToConnection(event, this.connectionId);
  }

  /**
   * Clean up all sessions.
   */
  async cleanup(): Promise<void> {
    // Cleanup window pool
    if (this.windowPool) {
      await this.windowPool.cleanup();
      this.windowPool = null;
    }

    // Cleanup default pool
    if (this.defaultPool) {
      await this.defaultPool.cleanup();
      this.defaultPool = null;
    }
  }
}
