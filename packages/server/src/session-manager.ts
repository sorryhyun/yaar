/**
 * Session manager - manages multiple agent sessions per WebSocket connection.
 *
 * Enables fork-session functionality where users can spawn window-specific
 * agents that run in parallel with the main agent.
 */

import type { WebSocket } from 'ws';
import { AgentSession } from './agent-session.js';
import { actionEmitter } from './tools/index.js';
import type { ClientEvent, ServerEvent } from '@claudeos/shared';

const MAX_WINDOW_AGENTS = 5;

export class SessionManager {
  private ws: WebSocket;
  private mainSession: AgentSession | null = null;
  private windowSessions: Map<string, AgentSession> = new Map();

  constructor(ws: WebSocket) {
    this.ws = ws;
  }

  /**
   * Initialize the main session.
   */
  async initialize(): Promise<boolean> {
    // Main session: no pre-assigned sessionId, no windowId, no fork
    this.mainSession = new AgentSession(this.ws);
    return this.mainSession.initialize();
  }

  /**
   * Route incoming messages to the appropriate session.
   */
  async routeMessage(event: ClientEvent): Promise<void> {
    switch (event.type) {
      case 'USER_MESSAGE':
        // Route to main session
        await this.mainSession?.handleMessage(event.content);
        break;

      case 'WINDOW_MESSAGE':
        await this.handleWindowMessage(event.windowId, event.content);
        break;

      case 'INTERRUPT':
        // Interrupt main session
        await this.mainSession?.interrupt();
        break;

      case 'INTERRUPT_AGENT':
        // Interrupt specific agent by ID
        await this.interruptAgent(event.agentId);
        break;

      case 'SET_PROVIDER':
        await this.mainSession?.setProvider(event.provider);
        break;

      case 'RENDERING_FEEDBACK':
        // Rendering feedback goes to all sessions (action emitter handles it)
        this.mainSession?.handleRenderingFeedback(
          event.requestId,
          event.windowId,
          event.renderer,
          event.success,
          event.error,
          event.url
        );
        break;
    }
  }

  /**
   * Handle a message targeted at a specific window.
   * Creates or reuses a window-specific agent session.
   */
  private async handleWindowMessage(windowId: string, content: string): Promise<void> {
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
      const mainSessionId = this.mainSession?.getRawSessionId() ?? undefined;
      const sharedLogger = this.mainSession?.getSessionLogger() ?? undefined;
      session = new AgentSession(this.ws, undefined, windowId, mainSessionId, sharedLogger);

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

      // Lock the window for this agent
      actionEmitter.emitAction(
        { type: 'window.lock', windowId, agentId },
        undefined,
        agentId
      );

      // Notify frontend about new agent
      await this.sendEvent({
        type: 'WINDOW_AGENT_STATUS',
        windowId,
        agentId,
        status: 'created',
      });
    }

    // Send status update
    await this.sendEvent({
      type: 'WINDOW_AGENT_STATUS',
      windowId,
      agentId: session.getSessionId(),
      status: 'active',
    });

    // Process the message
    await session.handleMessage(content);

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
    if (agentId === 'main') {
      await this.mainSession?.interrupt();
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

    // Unlock the window
    actionEmitter.emitAction(
      { type: 'window.unlock', windowId, agentId },
      undefined,
      agentId
    );

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

    // Cleanup main session
    if (this.mainSession) {
      await this.mainSession.cleanup();
      this.mainSession = null;
    }
  }
}
