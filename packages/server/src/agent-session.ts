/**
 * Agent session management.
 *
 * Manages a single WebSocket session with an AI provider via the transport layer.
 */

import type { WebSocket } from 'ws';
import type { AITransport, TransportOptions, ProviderType } from './providers/types.js';
import {
  createTransport,
  getFirstAvailableTransport,
  getAvailableTransports,
} from './providers/factory.js';
import { SYSTEM_PROMPT } from './system-prompt.js';
import type { ServerEvent } from '@claudeos/shared';
import { createSession, SessionLogger } from './sessions/index.js';
import { actionEmitter, type ActionEvent } from './tools/index.js';

export class AgentSession {
  private ws: WebSocket;
  private transport: AITransport | null = null;
  private sessionId: string | null = null;
  private running = false;
  private sessionLogger: SessionLogger | null = null;
  private unsubscribeAction: (() => void) | null = null;
  private windowId?: string;
  private forkFromSessionId?: string;
  private hasSentFirstMessage = false;

  /**
   * Create an agent session.
   * @param ws - WebSocket connection
   * @param sessionId - Session ID for this agent (optional, assigned by SDK if not provided)
   * @param windowId - Window ID if this is a window-specific agent
   * @param forkFromSessionId - Parent session ID to fork from (for window agents)
   */
  constructor(ws: WebSocket, sessionId?: string, windowId?: string, forkFromSessionId?: string) {
    this.ws = ws;
    this.sessionId = sessionId ?? null;
    this.windowId = windowId;
    this.forkFromSessionId = forkFromSessionId;
    // Subscribe to actions emitted directly from tools
    this.unsubscribeAction = actionEmitter.onAction(this.handleToolAction.bind(this));
  }

  /**
   * Get the window ID this session is associated with (if any).
   */
  getWindowId(): string | undefined {
    return this.windowId;
  }

  /**
   * Get the agent identifier.
   * Returns 'main' for the main agent, or 'window-{windowId}' for window agents.
   * Once the SDK assigns a session ID, returns that for resumption purposes.
   */
  getSessionId(): string {
    // If we have an SDK-assigned session ID, use it
    if (this.sessionId) {
      return this.sessionId;
    }
    // For window agents without SDK session yet, use window-based ID
    if (this.windowId) {
      return `window-${this.windowId}`;
    }
    // Main agent
    return 'main';
  }

  /**
   * Get the raw session ID (may be null for main agent before first message).
   */
  getRawSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Handle actions emitted directly from tools.
   * Filters actions to only handle ones matching this session's agentId.
   */
  private async handleToolAction(event: ActionEvent): Promise<void> {
    // Filter: only handle actions for this agent (or unspecified agentId for main)
    if (event.agentId && event.agentId !== this.getSessionId()) {
      return;
    }
    // For main agent, also skip if action is explicitly for another agent
    if (this.getSessionId() === 'main' && event.agentId && event.agentId !== 'main') {
      return;
    }

    // Include requestId in the action if present (for iframe feedback tracking)
    const action = event.requestId
      ? { ...event.action, requestId: event.requestId }
      : event.action;

    await this.sendEvent({
      type: 'ACTIONS',
      actions: [action],
      agentId: this.getSessionId(),
    });
    // Log action
    await this.sessionLogger?.logAction(action);
  }

  /**
   * Initialize with the first available transport.
   */
  async initialize(): Promise<boolean> {
    this.transport = await getFirstAvailableTransport();

    if (!this.transport) {
      await this.sendEvent({
        type: 'ERROR',
        error: 'No AI provider available. Install Claude CLI.',
      });
      return false;
    }

    // Create session logger
    const sessionInfo = await createSession(this.transport.name);
    this.sessionLogger = new SessionLogger(sessionInfo);

    await this.sendEvent({
      type: 'CONNECTION_STATUS',
      status: 'connected',
      provider: this.transport.name,
      sessionId: this.sessionId ?? undefined,
    });

    return true;
  }

  /**
   * Process a user message through the AI provider.
   */
  async handleMessage(content: string): Promise<void> {
    if (!this.transport) {
      return;
    }

    this.running = true;

    // Log user message
    await this.sessionLogger?.logUserMessage(content);

    try {
      // For the first message of a forked session, use the parent session ID with forkSession flag
      const shouldFork = !this.hasSentFirstMessage && !!this.forkFromSessionId;

      // Determine the session ID to use:
      // - For forking: use the parent session ID to fork from (SDK will create new session and return its ID)
      // - For resumption: use our session ID only if we've already sent a message (it's a real session)
      // - For new sessions: don't pass a session ID (let SDK create one)
      let sessionIdToUse: string | undefined;
      if (shouldFork) {
        sessionIdToUse = this.forkFromSessionId;
      } else if (this.hasSentFirstMessage && this.sessionId) {
        // Only resume if we've already sent a message (session exists in SDK)
        sessionIdToUse = this.sessionId;
      }
      // If neither, sessionIdToUse is undefined -> creates new session

      const options: TransportOptions = {
        systemPrompt: SYSTEM_PROMPT,
        sessionId: sessionIdToUse,
        forkSession: shouldFork ? true : undefined,
      };
      this.hasSentFirstMessage = true;

      let responseText = '';
      let thinkingText = '';

      for await (const message of this.transport.query(content, options)) {
        if (!this.running) break;

        switch (message.type) {
          case 'text':
            // Update session ID if provided
            if (message.sessionId) {
              this.sessionId = message.sessionId;
              await this.sendEvent({
                type: 'CONNECTION_STATUS',
                status: 'connected',
                provider: this.transport.name,
                sessionId: this.sessionId,
              });
            }

            // Accumulate response text and send update
            if (message.content) {
              responseText += message.content;
              await this.sendEvent({
                type: 'AGENT_RESPONSE',
                content: responseText,
                isComplete: false,
                agentId: this.getSessionId(),
              });
            }
            break;

          case 'thinking':
            if (message.content) {
              thinkingText += message.content;
              await this.sendEvent({
                type: 'AGENT_THINKING',
                content: thinkingText,
                agentId: this.getSessionId(),
              });
            }
            break;

          case 'tool_use':
            await this.sendEvent({
              type: 'TOOL_PROGRESS',
              toolName: message.toolName ?? 'unknown',
              status: 'running',
              agentId: this.getSessionId(),
            });
            break;

          case 'tool_result':
            // Actions are emitted directly from tools via actionEmitter
            await this.sendEvent({
              type: 'TOOL_PROGRESS',
              toolName: message.toolName ?? 'tool',
              status: 'complete',
              agentId: this.getSessionId(),
            });
            break;

          case 'complete':
            if (message.sessionId) {
              this.sessionId = message.sessionId;
            }
            // Log assistant response
            if (responseText) {
              await this.sessionLogger?.logAssistantMessage(responseText);
              await this.sessionLogger?.updateLastActivity();
            }
            await this.sendEvent({
              type: 'AGENT_RESPONSE',
              content: responseText,
              isComplete: true,
              agentId: this.getSessionId(),
            });
            break;

          case 'error':
            await this.sendEvent({
              type: 'ERROR',
              error: message.error ?? 'Unknown error',
              agentId: this.getSessionId(),
            });
            break;
        }
      }
    } catch (err) {
      await this.sendEvent({
        type: 'ERROR',
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.running = false;
    }
  }

  /**
   * Interrupt the current operation.
   */
  async interrupt(): Promise<void> {
    this.running = false;
    this.transport?.interrupt();
  }

  /**
   * Handle rendering feedback from the frontend.
   * Routes feedback to the action emitter to resolve pending tool calls.
   */
  handleRenderingFeedback(
    requestId: string,
    windowId: string,
    renderer: string,
    success: boolean,
    error?: string,
    url?: string
  ): void {
    const resolved = actionEmitter.resolveFeedback({
      requestId,
      windowId,
      renderer,
      success,
      error,
      url,
    });

    if (resolved) {
      console.log('[Rendering Feedback] Resolved:', { requestId, success, error });
    } else {
      console.log('[Rendering Feedback] No pending request:', { requestId });
    }
  }

  /**
   * Switch to a different provider.
   */
  async setProvider(providerType: ProviderType): Promise<void> {
    const available = await getAvailableTransports();
    if (!available.includes(providerType)) {
      await this.sendEvent({
        type: 'ERROR',
        error: `Provider ${providerType} is not available.`,
      });
      return;
    }

    // Dispose current transport
    if (this.transport) {
      await this.transport.dispose();
    }

    // Create new transport (async with dynamic import)
    const newTransport = await createTransport(providerType);
    this.transport = newTransport;
    this.sessionId = null;

    await this.sendEvent({
      type: 'CONNECTION_STATUS',
      status: 'connected',
      provider: newTransport.name,
    });
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
   * Clean up resources.
   */
  async cleanup(): Promise<void> {
    // Unsubscribe from action emitter
    if (this.unsubscribeAction) {
      this.unsubscribeAction();
      this.unsubscribeAction = null;
    }
    if (this.transport) {
      await this.transport.dispose();
      this.transport = null;
    }
  }
}
