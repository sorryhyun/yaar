/**
 * Session manager - manages multiple agent sessions per WebSocket connection.
 *
 * Agent types:
 * - Default agent pool: Pool of agents for handling concurrent user messages
 * - Window agent: Spawned for specific windows, runs in parallel with default agent
 * - Subagent: Spawned by default/window agents via SDK native feature
 */

import type { WebSocket } from 'ws';
import { AgentSession } from './agent-session.js';
import { DefaultAgentPool } from './default-agent-pool.js';
import type { ClientEvent, ServerEvent } from '@claudeos/shared';

const MAX_WINDOW_AGENTS = 5;

export class SessionManager {
  private ws: WebSocket;
  private defaultPool: DefaultAgentPool | null = null;
  private windowSessions: Map<string, AgentSession> = new Map();

  constructor(ws: WebSocket) {
    this.ws = ws;
  }

  /**
   * Initialize the main session pool.
   */
  async initialize(): Promise<boolean> {
    this.defaultPool = new DefaultAgentPool(this.ws);
    return this.defaultPool.initialize();
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
        await this.handleWindowMessage(event.messageId, event.windowId, event.content);
        break;

      case 'COMPONENT_ACTION':
        // Route component action to the appropriate agent
        await this.handleComponentAction(event.windowId, event.action);
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
   * Handle a component action (button click) from a window.
   * Routes to window agent if one exists, otherwise to default agent.
   */
  private async handleComponentAction(windowId: string, action: string): Promise<void> {
    // Check if window has its own agent
    const windowSession = this.windowSessions.get(windowId);

    if (windowSession) {
      // Send to window agent
      await this.sendEvent({
        type: 'WINDOW_AGENT_STATUS',
        windowId,
        agentId: windowSession.getSessionId(),
        status: 'active',
      });

      await windowSession.handleMessage(action);

      await this.sendEvent({
        type: 'WINDOW_AGENT_STATUS',
        windowId,
        agentId: windowSession.getSessionId(),
        status: 'idle',
      });
    } else {
      // Route to pool with context about which window triggered it
      // Generate a messageId for component actions
      const messageId = `component-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const contextualMessage = `[Component action from window "${windowId}"] ${action}`;
      await this.defaultPool?.handleMessage(messageId, contextualMessage);
    }
  }

  /**
   * Handle a message targeted at a specific window.
   * Creates or reuses a window-specific agent session.
   * Window agents use sequential queuing - new messages wait for current to complete.
   */
  private async handleWindowMessage(messageId: string, windowId: string, content: string): Promise<void> {
    let session = this.windowSessions.get(windowId);

    if (!session) {
      // Check limit
      if (this.windowSessions.size >= MAX_WINDOW_AGENTS) {
        await this.sendEvent({
          type: 'ERROR',
          error: `Maximum of ${MAX_WINDOW_AGENTS} window agents reached. Close a window to create more.`,
        });
        return;
      }

      // Create new window session, forking from main session's context
      // Session ID will be assigned by the SDK and captured from the stream
      // Share the main session's logger so all logs go to one place
      const defaultSessionId = this.defaultPool?.getRawSessionId() ?? undefined;
      const sharedLogger = this.defaultPool?.getSessionLogger() ?? undefined;
      session = new AgentSession(this.ws, undefined, windowId, defaultSessionId, sharedLogger);

      // Initialize the session
      const initialized = await session.initialize();
      if (!initialized) {
        await this.sendEvent({
          type: 'ERROR',
          error: `Failed to initialize window agent for ${windowId}`,
        });
        return;
      }

      this.windowSessions.set(windowId, session);

      // Use windowId as the agent identifier (the SDK session ID will be captured later)
      const agentId = `window-${windowId}`;

      // Notify frontend about new agent
      await this.sendEvent({
        type: 'WINDOW_AGENT_STATUS',
        windowId,
        agentId,
        status: 'created',
      });
    }

    // Check if window agent is busy - if so, queue the message
    if (session.isRunning()) {
      const queuePosition = session.queueMessage(messageId, content);
      await this.sendEvent({
        type: 'MESSAGE_QUEUED',
        messageId,
        position: queuePosition,
      });
      console.log(`[SessionManager] Queued message ${messageId} for window ${windowId}, position: ${queuePosition}`);
      return;
    }

    // Send status update
    await this.sendEvent({
      type: 'WINDOW_AGENT_STATUS',
      windowId,
      agentId: session.getSessionId(),
      status: 'active',
    });

    // Notify frontend that message is accepted
    await this.sendEvent({
      type: 'MESSAGE_ACCEPTED',
      messageId,
      agentId: session.getSessionId(),
    });

    // Process the message
    await session.handleMessage(content, undefined, messageId);

    // Send idle status after completion
    await this.sendEvent({
      type: 'WINDOW_AGENT_STATUS',
      windowId,
      agentId: session.getSessionId(),
      status: 'idle',
    });
  }

  /**
   * Interrupt a specific agent by ID.
   */
  private async interruptAgent(agentId: string): Promise<void> {
    if (agentId === 'default') {
      await this.defaultPool?.interruptAll();
      return;
    }

    // Find window session by agentId
    for (const session of this.windowSessions.values()) {
      if (session.getSessionId() === agentId) {
        await session.interrupt();
        return;
      }
    }
  }

  /**
   * Destroy a window agent session.
   */
  async destroyWindowAgent(windowId: string): Promise<void> {
    const session = this.windowSessions.get(windowId);
    if (!session) return;

    const agentId = session.getSessionId();

    // Notify frontend
    await this.sendEvent({
      type: 'WINDOW_AGENT_STATUS',
      windowId,
      agentId,
      status: 'destroyed',
    });

    // Cleanup
    await session.cleanup();
    this.windowSessions.delete(windowId);
  }

  /**
   * Check if a window has an active agent.
   */
  hasWindowAgent(windowId: string): boolean {
    return this.windowSessions.has(windowId);
  }

  /**
   * Get the agent ID for a window (if any).
   */
  getWindowAgentId(windowId: string): string | undefined {
    return this.windowSessions.get(windowId)?.getSessionId();
  }

  /**
   * Send an event to the client.
   */
  private async sendEvent(event: ServerEvent): Promise<void> {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify(event));
    }
  }

  /**
   * Clean up all sessions.
   */
  async cleanup(): Promise<void> {
    // Cleanup all window sessions
    for (const session of this.windowSessions.values()) {
      await session.cleanup();
    }
    this.windowSessions.clear();

    // Cleanup default pool
    if (this.defaultPool) {
      await this.defaultPool.cleanup();
      this.defaultPool = null;
    }
  }
}
