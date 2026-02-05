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
  getAvailableProviders,
  acquireWarmProvider,
} from '../providers/factory.js';
import type { ServerEvent, UserInteraction, OSAction } from '@yaar/shared';
import { createSession, SessionLogger } from '../logging/index.js';
import { actionEmitter, type ActionEvent } from '../mcp/index.js';
import { getBroadcastCenter, type ConnectionId } from '../events/broadcast-center.js';
import type { ContextSource } from './context.js';

/**
 * Options for handling a message with dynamic role assignment.
 */
export interface HandleMessageOptions {
  /** Role to use for this message ('main-{messageId}' or 'window-{id}') */
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
  private recordedActions: OSAction[] = []; // Buffer for action recording (reload cache)

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
   * Get the actions recorded during the current/last message processing.
   * Returns a shallow copy to prevent external mutation.
   */
  getRecordedActions(): OSAction[] {
    return [...this.recordedActions];
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

    // Record clean action for reload cache (before adding UI metadata)
    this.recordedActions.push(event.action);

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
   * Uses warm pool for faster initialization.
   * @param preWarmedProvider - Optional pre-warmed provider to use instead of acquiring new one
   */
  async initialize(preWarmedProvider?: AITransport): Promise<boolean> {
    // Use provided provider or acquire from warm pool
    this.provider = preWarmedProvider ?? (await acquireWarmProvider());

    if (!this.provider) {
      await this.sendEvent({
        type: 'ERROR',
        error: 'No AI provider available. Install Claude CLI.',
      });
      return false;
    }

    // Copy session ID from pre-warmed provider if available
    // This ensures we resume the warmed session instead of creating a new one
    if (!this.sessionId && this.provider.getSessionId) {
      const warmSessionId = this.provider.getSessionId();
      if (warmSessionId) {
        this.sessionId = warmSessionId;
        this.hasSentFirstMessage = true; // Mark as having sent first message (the warmup ping)
        console.log(`[AgentSession] Using pre-warmed session: ${warmSessionId}`);
      }
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
   * Format user interactions into context string and extract images.
   * Returns both the text context and array of image data URLs.
   */
  private formatInteractions(interactions: UserInteraction[]): { text: string; images: string[] } {
    if (interactions.length === 0) return { text: '', images: [] };

    // Separate drawings from other interactions
    const drawings = interactions.filter(i => i.type === 'draw' && i.imageData);
    const otherInteractions = interactions.filter(i => i.type !== 'draw');

    const parts: string[] = [];

    // Format non-drawing interactions as text
    if (otherInteractions.length > 0) {
      const lines = otherInteractions.map(i => {
        let content = '';
        if (i.windowTitle) content += `"${i.windowTitle}"`;
        if (i.details) content += content ? ` (${i.details})` : i.details;
        return `<user_interaction:${i.type}>${content}</user_interaction:${i.type}>`;
      });
      parts.push(`<previous_interactions>\n${lines.join('\n')}\n</previous_interactions>`);
    }

    // Add a note about drawings if present (images sent separately)
    if (drawings.length > 0) {
      parts.push(`<user_interaction:draw>[User drawing attached as image]</user_interaction:draw>`);
    }

    const text = parts.length > 0 ? parts.join('\n\n') + '\n\n' : '';
    const images = drawings
      .map(d => d.imageData)
      .filter((img): img is string => img !== undefined);

    console.log(`[AgentSession] formatInteractions: ${drawings.length} drawings, ${images.length} images extracted`);
    if (images.length > 0) {
      console.log(`[AgentSession] First image prefix: ${images[0].slice(0, 50)}...`);
    }

    return { text, images };
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
    this.recordedActions = []; // Clear buffer for fresh recording

    // Immediately notify frontend that agent is thinking
    await this.sendEvent({
      type: 'AGENT_THINKING',
      content: '',
      agentId: role,
    });

    // Prepend interaction context if available, extract images separately
    const { text: interactionContext, images } = interactions
      ? this.formatInteractions(interactions)
      : { text: '', images: [] };
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
      console.log(`[AgentSession] ${role} sessionIdToUse: ${sessionIdToUse}, hasSentFirstMessage: ${this.hasSentFirstMessage}, this.sessionId: ${this.sessionId}`);

      const transportOptions: TransportOptions = {
        systemPrompt: this.provider!.systemPrompt,
        sessionId: sessionIdToUse,
        images: images.length > 0 ? images : undefined,
      };
      console.log(`[AgentSession] ${role} transportOptions: sessionId=${sessionIdToUse}, images=${images.length}`);
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
                await this.sessionLogger?.logThinking(message.content, role);
              }
              break;

            case 'tool_use':
              await this.sendEvent({
                type: 'TOOL_PROGRESS',
                toolName: message.toolName ?? 'unknown',
                status: 'running',
                agentId: role,
              });
              await this.sessionLogger?.logToolUse(
                message.toolName ?? 'unknown',
                message.toolInput,
                message.toolUseId,
                role
              );
              break;

            case 'tool_result':
              await this.sendEvent({
                type: 'TOOL_PROGRESS',
                toolName: message.toolName ?? 'tool',
                status: 'complete',
                agentId: role,
              });
              await this.sessionLogger?.logToolResult(
                message.toolName ?? 'tool',
                message.content,
                message.toolUseId,
                role
              );
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
    locked?: boolean,
    imageData?: string
  ): void {
    const resolved = actionEmitter.resolveFeedback({
      requestId,
      windowId,
      renderer,
      success,
      error,
      url,
      locked,
      imageData,
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
