/**
 * Agent session management.
 *
 * Manages a single WebSocket session with an AI provider via the transport layer.
 */

import type { WebSocket } from 'ws';
import { AsyncLocalStorage } from 'async_hooks';
import type { AITransport, TransportOptions, ProviderType } from './providers/types.js';
import {
  createProvider,
  getFirstAvailableProvider,
  getAvailableProviders,
} from './providers/factory.js';
import { SYSTEM_PROMPT } from './system-prompt.js';
import type { ServerEvent, UserInteraction } from '@claudeos/shared';
import { createSession, SessionLogger } from './sessions/index.js';
import { actionEmitter, type ActionEvent } from './tools/index.js';

/**
 * Queued message structure for sequential processing.
 */
interface QueuedMessage {
  messageId: string;
  content: string;
  interactions?: UserInteraction[];
}

/**
 * Agent context - tracks which agent is currently executing so tools
 * can include the agentId in their actions.
 */
interface AgentContext {
  agentId: string;
}

const agentContext = new AsyncLocalStorage<AgentContext>();

/**
 * Get the current agent ID from context.
 * Used by tools to include agentId in actions for lock verification.
 */
export function getAgentId(): string | undefined {
  return agentContext.getStore()?.agentId;
}

export class AgentSession {
  private ws: WebSocket;
  private provider: AITransport | null = null;
  private sessionId: string | null = null;
  private running = false;
  private sessionLogger: SessionLogger | null = null;
  private unsubscribeAction: (() => void) | null = null;
  private windowId?: string;
  private forkFromSessionId?: string;
  private hasSentFirstMessage = false;
  private currentMessageId: string | null = null;
  private messageQueue: QueuedMessage[] = [];
  private processingQueue = false;

  /**
   * Create an agent session.
   * @param ws - WebSocket connection
   * @param sessionId - Session ID for this agent (optional, assigned by SDK if not provided)
   * @param windowId - Window ID if this is a window-specific agent
   * @param forkFromSessionId - Parent session ID to fork from (for window agents)
   * @param sharedLogger - Optional shared logger (for window agents to use main session's log)
   */
  constructor(
    ws: WebSocket,
    sessionId?: string,
    windowId?: string,
    forkFromSessionId?: string,
    sharedLogger?: SessionLogger
  ) {
    this.ws = ws;
    this.sessionId = sessionId ?? null;
    this.windowId = windowId;
    this.forkFromSessionId = forkFromSessionId;
    this.sessionLogger = sharedLogger ?? null;
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
   * Check if the agent is currently processing a message.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get the current message ID being processed.
   */
  getCurrentMessageId(): string | null {
    return this.currentMessageId;
  }

  /**
   * Get the number of queued messages.
   */
  getQueueLength(): number {
    return this.messageQueue.length;
  }

  /**
   * Queue a message for later processing (used by window agents).
   * Returns the position in the queue.
   */
  queueMessage(messageId: string, content: string, interactions?: UserInteraction[]): number {
    this.messageQueue.push({ messageId, content, interactions });
    return this.messageQueue.length;
  }

  /**
   * Get the agent identifier.
   * Returns 'default' for the default agent, or 'window-{windowId}' for window agents.
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
    // Default agent
    return 'default';
  }

  /**
   * Get the raw session ID (may be null for default agent before first message).
   */
  getRawSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Get the stable agent ID for filtering actions.
   * For window agents, this is always 'window-{windowId}' regardless of SDK session ID.
   * This ensures consistency since the agentContext is set before SDK assigns session ID.
   */
  private getFilterAgentId(): string {
    if (this.windowId) {
      return `window-${this.windowId}`;
    }
    return 'default';
  }

  /**
   * Handle actions emitted directly from tools.
   * Filters actions to only handle ones matching this session's agentId.
   */
  private async handleToolAction(event: ActionEvent): Promise<void> {
    const myAgentId = this.getFilterAgentId();

    // Filter: only handle actions for this agent (or unspecified agentId for main)
    if (event.agentId && event.agentId !== myAgentId) {
      return;
    }
    // For default agent, also skip if action is explicitly for another agent
    if (myAgentId === 'default' && event.agentId && event.agentId !== 'default') {
      return;
    }

    // Include requestId and agentId in the action for frontend tracking
    const action = {
      ...event.action,
      ...(event.requestId && { requestId: event.requestId }),
      ...(event.agentId && { agentId: event.agentId }),
    };

    await this.sendEvent({
      type: 'ACTIONS',
      actions: [action],
      agentId: this.getSessionId(),
    });
    // Log action with agent identifier
    await this.sessionLogger?.logAction(action, this.getSessionId());
  }

  /**
   * Initialize with the first available transport.
   */
  async initialize(): Promise<boolean> {
    this.provider = await getFirstAvailableProvider();

    if (!this.provider) {
      await this.sendEvent({
        type: 'ERROR',
        error: 'No AI provider available. Install Claude CLI.',
      });
      return false;
    }

    // Create session logger only if not using a shared one
    if (!this.sessionLogger) {
      const sessionInfo = await createSession(this.provider.name);
      this.sessionLogger = new SessionLogger(sessionInfo);
    }

    await this.sendEvent({
      type: 'CONNECTION_STATUS',
      status: 'connected',
      provider: this.provider.name,
      sessionId: this.sessionId ?? undefined,
    });

    return true;
  }

  /**
   * Get the session logger (for sharing with subagents).
   */
  getSessionLogger(): SessionLogger | null {
    return this.sessionLogger;
  }

  /**
   * Format user interactions into context string.
   */
  private formatInteractions(interactions: UserInteraction[]): string {
    if (interactions.length === 0) return '';

    const lines = interactions.map(i => {
      const time = new Date(i.timestamp).toLocaleTimeString();
      let desc = i.type;
      if (i.windowTitle) desc += ` "${i.windowTitle}"`;
      if (i.details) desc += ` (${i.details})`;
      return `- [${time}] ${desc}`;
    });

    return `<previous_interactions>\n${lines.join('\n')}\n</previous_interactions>\n\n`;
  }

  /**
   * Process a user message through the AI provider.
   */
  async handleMessage(content: string, interactions?: UserInteraction[], messageId?: string): Promise<void> {
    if (!this.provider) {
      return;
    }

    this.running = true;
    this.currentMessageId = messageId ?? null;

    // Immediately notify frontend that agent is thinking
    const stableAgentId = this.getFilterAgentId();
    await this.sendEvent({
      type: 'AGENT_THINKING',
      content: '',
      agentId: stableAgentId,
    });

    // Prepend interaction context if available
    const interactionContext = interactions ? this.formatInteractions(interactions) : '';
    const fullContent = interactionContext + content;

    // Log user message with agent identifier
    await this.sessionLogger?.logUserMessage(fullContent, stableAgentId);

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

      // Run within agent context so tools can access the agentId
      // Use getFilterAgentId() for stable UI tracking ('default' or 'window-{id}')
      const currentAgentId = this.getFilterAgentId();
      await agentContext.run({ agentId: currentAgentId }, async () => {
        for await (const message of this.provider!.query(fullContent, options)) {
          if (!this.running) break;

          switch (message.type) {
            case 'text':
              // Update session ID if provided (for session resumption)
              if (message.sessionId) {
                this.sessionId = message.sessionId;
                await this.sendEvent({
                  type: 'CONNECTION_STATUS',
                  status: 'connected',
                  provider: this.provider!.name,
                  sessionId: this.sessionId,
                });
              }

              // Accumulate response text and send update
              // Use stable agentId for UI tracking (currentAgentId captured at start)
              if (message.content) {
                responseText += message.content;
                await this.sendEvent({
                  type: 'AGENT_RESPONSE',
                  content: responseText,
                  isComplete: false,
                  agentId: currentAgentId,
                  messageId: this.currentMessageId ?? undefined,
                });
              }
              break;

            case 'thinking':
              if (message.content) {
                thinkingText += message.content;
                await this.sendEvent({
                  type: 'AGENT_THINKING',
                  content: thinkingText,
                  agentId: currentAgentId,
                });
              }
              break;

            case 'tool_use':
              await this.sendEvent({
                type: 'TOOL_PROGRESS',
                toolName: message.toolName ?? 'unknown',
                status: 'running',
                agentId: currentAgentId,
              });
              break;

            case 'tool_result':
              // Actions are emitted directly from tools via actionEmitter
              await this.sendEvent({
                type: 'TOOL_PROGRESS',
                toolName: message.toolName ?? 'tool',
                status: 'complete',
                agentId: currentAgentId,
              });
              break;

            case 'complete':
              if (message.sessionId) {
                this.sessionId = message.sessionId;
              }
              // Log assistant response with agent identifier
              if (responseText) {
                await this.sessionLogger?.logAssistantMessage(responseText, currentAgentId);
                await this.sessionLogger?.updateLastActivity();
              }
              await this.sendEvent({
                type: 'AGENT_RESPONSE',
                content: responseText,
                isComplete: true,
                agentId: currentAgentId,
                messageId: this.currentMessageId ?? undefined,
              });
              break;

            case 'error':
              await this.sendEvent({
                type: 'ERROR',
                error: message.error ?? 'Unknown error',
                agentId: currentAgentId,
              });
              break;
          }
        }
      });
    } catch (err) {
      await this.sendEvent({
        type: 'ERROR',
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.running = false;
      this.currentMessageId = null;

      // Process queued messages (for window agents)
      await this.processQueue();
    }
  }

  /**
   * Process queued messages sequentially.
   * Called automatically after handleMessage completes.
   */
  private async processQueue(): Promise<void> {
    if (this.processingQueue || this.messageQueue.length === 0) {
      return;
    }

    this.processingQueue = true;
    try {
      while (this.messageQueue.length > 0 && !this.running) {
        const next = this.messageQueue.shift();
        if (next) {
          await this.handleMessage(next.content, next.interactions, next.messageId);
        }
      }
    } finally {
      this.processingQueue = false;
    }
  }

  /**
   * Interrupt the current operation.
   */
  async interrupt(): Promise<void> {
    this.running = false;
    this.provider?.interrupt();
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
    url?: string,
    locked?: boolean
  ): void {
    const resolved = actionEmitter.resolveFeedback({
      requestId,
      windowId,
      renderer,
      success,
      error,
      url,
      locked,
    });

    if (resolved) {
      console.log('[Rendering Feedback] Resolved:', { requestId, success, locked });
    } else {
      console.log('[Rendering Feedback] No pending request:', { requestId });
    }
  }

  /**
   * Switch to a different provider.
   */
  async setProvider(providerType: ProviderType): Promise<void> {
    const available = await getAvailableProviders();
    if (!available.includes(providerType)) {
      await this.sendEvent({
        type: 'ERROR',
        error: `Provider ${providerType} is not available.`,
      });
      return;
    }

    // Dispose current provider
    if (this.provider) {
      await this.provider.dispose();
    }

    // Create new provider (async with dynamic import)
    const newProvider = await createProvider(providerType);
    this.provider = newProvider;
    this.sessionId = null;

    await this.sendEvent({
      type: 'CONNECTION_STATUS',
      status: 'connected',
      provider: newProvider.name,
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
    if (this.provider) {
      await this.provider.dispose();
      this.provider = null;
    }
  }
}
