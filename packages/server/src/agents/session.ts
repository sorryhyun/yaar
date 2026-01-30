/**
 * Agent session management.
 *
 * Manages a single WebSocket session with an AI provider via the transport layer.
 * Role is assigned dynamically per-message via handleMessage options.
 */

import { AsyncLocalStorage } from 'async_hooks';
import type { AITransport, TransportOptions, ProviderType } from '../providers/types.js';
import {
  createProvider,
  getFirstAvailableProvider,
  getAvailableProviders,
} from '../providers/factory.js';
import { SYSTEM_PROMPT } from '../system-prompt.js';
import type { ServerEvent, UserInteraction } from '@claudeos/shared';
import { createSession, SessionLogger } from '../logging/index.js';
import { actionEmitter, type ActionEvent } from '../tools/index.js';
import { getBroadcastCenter, type ConnectionId } from '../events/broadcast-center.js';
import type { ContextSource } from './context.js';

/**
 * Options for handling a message with dynamic role assignment.
 */
export interface HandleMessageOptions {
  /** Role to use for this message ('default' or 'window-{id}') */
  role: string;
  /** Source for context recording */
  source: ContextSource;
  /** User interactions to include as context */
  interactions?: UserInteraction[];
  /** Message ID for tracking */
  messageId?: string;
  /** Callback to record messages to context tape */
  onContextMessage?: (role: 'user' | 'assistant', content: string) => void;
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
  private connectionId: ConnectionId;
  private provider: AITransport | null = null;
  private sessionId: string | null = null;
  private running = false;
  private sessionLogger: SessionLogger | null = null;
  private unsubscribeAction: (() => void) | null = null;
  private instanceId: string; // Unique ID for this agent instance (for action filtering)
  private hasSentFirstMessage = false;
  private currentMessageId: string | null = null;
  private currentRole: string | null = null; // Current role being used

  /**
   * Create an agent session.
   * @param connectionId - Connection ID for routing events via broadcast center
   * @param sessionId - Session ID for this agent (optional, assigned by SDK if not provided)
   * @param sharedLogger - Optional shared logger
   * @param instanceId - Unique instance ID for this agent (for action filtering)
   */
  constructor(
    connectionId: ConnectionId,
    sessionId?: string,
    sharedLogger?: SessionLogger,
    instanceId?: string
  ) {
    this.connectionId = connectionId;
    this.sessionId = sessionId ?? null;
    this.instanceId = instanceId ?? `agent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.sessionLogger = sharedLogger ?? null;
    // Subscribe to actions emitted directly from tools
    this.unsubscribeAction = actionEmitter.onAction(this.handleToolAction.bind(this));
  }

  /**
   * Get the connection ID for this session.
   */
  getConnectionId(): ConnectionId {
    return this.connectionId;
  }

  /**
   * Get the instance ID for this session.
   */
  getInstanceId(): string {
    return this.instanceId;
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
   * Get the current role being used (for debugging).
   */
  getCurrentRole(): string | null {
    return this.currentRole;
  }

  /**
   * Get the agent identifier.
   * Returns the current role if active, otherwise 'default'.
   */
  getSessionId(): string {
    if (this.sessionId) {
      return this.sessionId;
    }
    return this.currentRole ?? 'default';
  }

  /**
   * Get the raw session ID (may be null before first message).
   */
  getRawSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Get the stable agent ID for filtering actions.
   * Uses the instance ID to prevent cross-talk between concurrent agents.
   */
  private getFilterAgentId(): string {
    return this.instanceId;
  }

  /**
   * Handle actions emitted directly from tools.
   * Filters actions to only handle ones matching this session's agentId.
   */
  private async handleToolAction(event: ActionEvent): Promise<void> {
    const myAgentId = this.getFilterAgentId();

    // Filter: only handle actions for this agent
    if (event.agentId && event.agentId !== myAgentId) {
      return;
    }

    // Include requestId and agentId in the action for frontend tracking
    // Use currentRole for the UI-facing agentId (not instanceId)
    const uiAgentId = this.currentRole ?? 'default';
    const action = {
      ...event.action,
      ...(event.requestId && { requestId: event.requestId }),
      agentId: uiAgentId,
    };

    await this.sendEvent({
      type: 'ACTIONS',
      actions: [action],
      agentId: uiAgentId,
    });
    // Log action with agent identifier
    await this.sessionLogger?.logAction(action, uiAgentId);
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
   * Role is assigned dynamically via options.
   */
  async handleMessage(content: string, options: HandleMessageOptions): Promise<void> {
    const { role, interactions, messageId, onContextMessage } = options;

    this.currentRole = role;
    const stableAgentId = this.instanceId;
    console.log(`[AgentSession] handleMessage started for ${role} (${stableAgentId}), content: "${content.slice(0, 50)}..."`);

    if (!this.provider) {
      console.log(`[AgentSession] No provider for ${role}, returning early`);
      return;
    }

    this.running = true;
    this.currentMessageId = messageId ?? null;

    // Immediately notify frontend that agent is thinking
    await this.sendEvent({
      type: 'AGENT_THINKING',
      content: '',
      agentId: role,
    });

    // Prepend interaction context if available
    const interactionContext = interactions ? this.formatInteractions(interactions) : '';
    const fullContent = interactionContext + content;

    // Log user message with role identifier
    await this.sessionLogger?.logUserMessage(fullContent, role);

    // Record to context tape
    onContextMessage?.('user', fullContent);

    try {
      // Determine the session ID to use for resumption
      let sessionIdToUse: string | undefined;
      if (this.hasSentFirstMessage && this.sessionId) {
        sessionIdToUse = this.sessionId;
      }

      const transportOptions: TransportOptions = {
        systemPrompt: SYSTEM_PROMPT,
        sessionId: sessionIdToUse,
      };
      this.hasSentFirstMessage = true;

      let responseText = '';
      let thinkingText = '';

      // Run within agent context so tools can access the agentId
      // Use instanceId for action filtering (prevents cross-talk)
      console.log(`[AgentSession] ${role} starting query with content: "${fullContent.slice(0, 50)}..."`);
      await agentContext.run({ agentId: stableAgentId }, async () => {
        console.log(`[AgentSession] ${role} entered agentContext.run`);
        for await (const message of this.provider!.query(fullContent, transportOptions)) {
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
              if (message.content) {
                responseText += message.content;
                await this.sendEvent({
                  type: 'AGENT_RESPONSE',
                  content: responseText,
                  isComplete: false,
                  agentId: role,
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
                  agentId: role,
                });
              }
              break;

            case 'tool_use':
              await this.sendEvent({
                type: 'TOOL_PROGRESS',
                toolName: message.toolName ?? 'unknown',
                status: 'running',
                agentId: role,
              });
              break;

            case 'tool_result':
              await this.sendEvent({
                type: 'TOOL_PROGRESS',
                toolName: message.toolName ?? 'tool',
                status: 'complete',
                agentId: role,
              });
              break;

            case 'complete':
              if (message.sessionId) {
                this.sessionId = message.sessionId;
              }
              // Log assistant response
              if (responseText) {
                await this.sessionLogger?.logAssistantMessage(responseText, role);
                await this.sessionLogger?.updateLastActivity();
                // Record to context tape
                onContextMessage?.('assistant', responseText);
              }
              await this.sendEvent({
                type: 'AGENT_RESPONSE',
                content: responseText,
                isComplete: true,
                agentId: role,
                messageId: this.currentMessageId ?? undefined,
              });
              break;

            case 'error':
              await this.sendEvent({
                type: 'ERROR',
                error: message.error ?? 'Unknown error',
                agentId: role,
              });
              break;
          }
        }
        console.log(`[AgentSession] ${role} query loop completed`);
      });
    } catch (err) {
      console.error(`[AgentSession] ${role} error:`, err);
      await this.sendEvent({
        type: 'ERROR',
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      console.log(`[AgentSession] ${role} handleMessage completed`);
      this.running = false;
      this.currentMessageId = null;
      this.currentRole = null;
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
   * Send an event to the client via broadcast center.
   */
  private async sendEvent(event: ServerEvent): Promise<void> {
    getBroadcastCenter().publishToConnection(event, this.connectionId);
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
