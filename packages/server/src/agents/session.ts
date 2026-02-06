/**
 * Agent session management.
 *
 * Manages a single WebSocket session with an AI provider via the transport layer.
 * Role is assigned dynamically per-message via handleMessage options.
 */

import { AsyncLocalStorage } from 'async_hooks';
import type { AITransport, TransportOptions, ProviderType } from '../providers/types.js';
import type { ServerEvent, UserInteraction, OSAction } from '@yaar/shared';
import type { SessionLogger } from '../logging/index.js';
import { actionEmitter } from '../mcp/action-emitter.js';
import { getBroadcastCenter, type ConnectionId } from '../events/broadcast-center.js';
import type { ContextSource } from './context.js';
import { configRead } from '../storage/storage-manager.js';
import { StreamToEventMapper } from './session-policies/stream-to-event-mapper.js';
import { ProviderLifecycleManager } from './session-policies/provider-lifecycle-manager.js';
import { ToolActionBridge } from './session-policies/tool-action-bridge.js';

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
  /** When true, fork from the parent session instead of continuing it */
  forkSession?: boolean;
  /** Parent session/thread ID to fork from (used with forkSession) */
  parentSessionId?: string;
}

interface AgentContext {
  agentId: string;
  connectionId: ConnectionId;
}

const agentContext = new AsyncLocalStorage<AgentContext>();

export function getAgentId(): string | undefined {
  return agentContext.getStore()?.agentId;
}

export function getCurrentConnectionId(): ConnectionId | undefined {
  return agentContext.getStore()?.connectionId;
}

async function loadMemory(): Promise<string> {
  const result = await configRead('memory.md');
  if (!result.success || !result.content?.trim()) {
    return '';
  }
  return `\n\n## Memory\nThe following notes were saved by you from previous sessions:\n${result.content.trim()}`;
}

export class AgentSession {
  private connectionId: ConnectionId;
  private provider: AITransport | null = null;
  private sessionId: string | null = null;
  private running = false;
  private sessionLogger: SessionLogger | null = null;
  private unsubscribeAction: (() => void) | null = null;
  private instanceId: string;
  private hasSentFirstMessage = false;
  private currentMessageId: string | null = null;
  private currentRole: string | null = null;
  private recordedActions: OSAction[] = [];

  private providerLifecycle: ProviderLifecycleManager;
  private toolActionBridge: ToolActionBridge;

  constructor(
    connectionId: ConnectionId,
    sessionId?: string,
    sharedLogger?: SessionLogger,
    instanceId?: string,
  ) {
    this.connectionId = connectionId;
    this.sessionId = sessionId ?? null;
    this.instanceId = instanceId ?? `agent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.sessionLogger = sharedLogger ?? null;

    const connection = this;

    this.providerLifecycle = new ProviderLifecycleManager(
      {
        get provider() {
          return connection.provider;
        },
        set provider(value: AITransport | null) {
          connection.provider = value;
        },
        get sessionId() {
          return connection.sessionId;
        },
        set sessionId(value: string | null) {
          connection.sessionId = value;
        },
        get hasSentFirstMessage() {
          return connection.hasSentFirstMessage;
        },
        set hasSentFirstMessage(value: boolean) {
          connection.hasSentFirstMessage = value;
        },
        get sessionLogger() {
          return connection.sessionLogger;
        },
        set sessionLogger(value: SessionLogger | null) {
          connection.sessionLogger = value;
        },
      },
      this.sendEvent.bind(this),
    );

    this.toolActionBridge = new ToolActionBridge(
      { get currentRole() { return connection.currentRole; } },
      this.sendEvent.bind(this),
      this.getFilterAgentId.bind(this),
      () => this.sessionLogger,
      (action) => this.recordedActions.push(action),
    );
    this.unsubscribeAction = actionEmitter.onAction(this.toolActionBridge.handleToolAction.bind(this.toolActionBridge));
  }

  getConnectionId(): ConnectionId {
    return this.connectionId;
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  isRunning(): boolean {
    return this.running;
  }

  getCurrentMessageId(): string | null {
    return this.currentMessageId;
  }

  getCurrentRole(): string | null {
    return this.currentRole;
  }

  getRecordedActions(): OSAction[] {
    return [...this.recordedActions];
  }

  getSessionId(): string {
    if (this.sessionId) {
      return this.sessionId;
    }
    return this.currentRole ?? 'default';
  }

  getRawSessionId(): string | null {
    return this.sessionId;
  }

  private getFilterAgentId(): string {
    return this.instanceId;
  }

  async initialize(preWarmedProvider?: AITransport): Promise<boolean> {
    return this.providerLifecycle.initialize(preWarmedProvider);
  }

  getSessionLogger(): SessionLogger | null {
    return this.sessionLogger;
  }

  private formatInteractions(interactions: UserInteraction[]): { text: string; images: string[] } {
    if (interactions.length === 0) return { text: '', images: [] };

    const drawings = interactions.filter(i => i.type === 'draw' && i.imageData);
    const otherInteractions = interactions.filter(i => i.type !== 'draw');

    const parts: string[] = [];

    if (otherInteractions.length > 0) {
      const lines = otherInteractions.map(i => {
        let content = '';
        if (i.windowTitle) content += `"${i.windowTitle}"`;
        if (i.details) content += content ? ` (${i.details})` : i.details;
        return `<user_interaction:${i.type}>${content}</user_interaction:${i.type}>`;
      });
      parts.push(`<previous_interactions>\n${lines.join('\n')}\n</previous_interactions>`);
    }

    if (drawings.length > 0) {
      parts.push(`<user_interaction:draw>[User drawing attached as image]</user_interaction:draw>`);
    }

    const text = parts.length > 0 ? parts.join('\n\n') + '\n\n' : '';
    const images = drawings
      .map(d => d.imageData)
      .filter((img): img is string => img !== undefined);

    return { text, images };
  }

  async handleMessage(content: string, options: HandleMessageOptions): Promise<void> {
    const { role, interactions, messageId, onContextMessage } = options;

    this.currentRole = role;
    const stableAgentId = this.instanceId;

    if (!this.provider) {
      return;
    }

    this.running = true;
    this.currentMessageId = messageId ?? null;
    this.recordedActions = [];

    await this.sendEvent({
      type: 'AGENT_THINKING',
      content: '',
      agentId: role,
    });

    const { text: interactionContext, images } = interactions
      ? this.formatInteractions(interactions)
      : { text: '', images: [] };
    const fullContent = interactionContext + content;

    // Log user message with role identifier and source
    await this.sessionLogger?.logUserMessage(fullContent, role, options.source);
    onContextMessage?.('user', fullContent);

    try {
      // For forked sessions, use the parent's session ID so the provider can fork from it.
      // Otherwise, resume our own session if we've already sent a message.
      let sessionIdToUse: string | undefined;
      if (options.forkSession && options.parentSessionId) {
        sessionIdToUse = options.parentSessionId;
      } else if (this.hasSentFirstMessage && this.sessionId) {
        sessionIdToUse = this.sessionId;
      }

      const memory = await loadMemory();
      const transportOptions: TransportOptions = {
        systemPrompt: this.provider.systemPrompt + memory,
        sessionId: sessionIdToUse,
        forkSession: options.forkSession,
        images: images.length > 0 ? images : undefined,
      };
      this.hasSentFirstMessage = true;

      const streamState = {
        responseText: '',
        thinkingText: '',
        currentMessageId: this.currentMessageId,
      };

      const mapper = new StreamToEventMapper(
        role,
        this.provider.name,
        streamState,
        this.sendEvent.bind(this),
        this.sessionLogger,
        options.source,
        onContextMessage,
        async (sessionId: string) => {
          // Update internal provider session ID for session resumption/forking.
          // The log session ID (sent to frontend) is managed by ContextPool.
          this.sessionId = sessionId;
        },
      );

      console.log(`[AgentSession] ${role} starting query with content: "${fullContent.slice(0, 50)}..."`);
      await agentContext.run({ agentId: stableAgentId, connectionId: this.connectionId }, async () => {
        console.log(`[AgentSession] ${role} entered agentContext.run`);
        for await (const message of this.provider!.query(fullContent, transportOptions)) {
          if (!this.running) break;
          await mapper.map(message);
        }
      });
    } catch (err) {
      console.error(`[AgentSession] ${role} error:`, err);
      await this.sendEvent({
        type: 'ERROR',
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.running = false;
      this.currentMessageId = null;
      this.currentRole = null;
    }
  }

  async interrupt(): Promise<void> {
    this.running = false;
    this.provider?.interrupt();
  }

  handleRenderingFeedback(
    requestId: string,
    windowId: string,
    renderer: string,
    success: boolean,
    error?: string,
    url?: string,
    locked?: boolean,
    imageData?: string,
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

  async setProvider(providerType: ProviderType): Promise<void> {
    await this.providerLifecycle.setProvider(providerType);
  }

  private async sendEvent(event: ServerEvent): Promise<void> {
    getBroadcastCenter().publishToConnection(event, this.connectionId);
  }

  async cleanup(): Promise<void> {
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
