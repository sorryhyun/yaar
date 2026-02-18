/**
 * Agent session management.
 *
 * Manages a single WebSocket session with an AI provider via the transport layer.
 * Role is assigned dynamically per-message via handleMessage options.
 */

import { AsyncLocalStorage } from 'async_hooks';
import type { AITransport, TransportOptions, ProviderType } from '../providers/types.js';
import {
  ServerEventType,
  type ServerEvent,
  type UserInteraction,
  type OSAction,
} from '@yaar/shared';
import type { SessionLogger } from '../logging/index.js';
import { actionEmitter } from '../mcp/action-emitter.js';
import type { ConnectionId } from '../session/broadcast-center.js';
import type { SessionId } from '../session/types.js';
import type { ContextSource } from './context.js';
import { configRead } from '../storage/storage-manager.js';
import { buildEnvironmentSection } from '../providers/environment.js';
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
  /** Canonical agent name for thread persistence (e.g. "default", "window-win1") */
  canonicalAgent?: string;
  /** Saved thread ID to resume (explicit restore only) */
  resumeSessionId?: string;
  /** Monitor ID for multi-monitor event stamping */
  monitorId?: string;
  /** Override the provider's base system prompt (used by task agents with profile prompts) */
  systemPromptOverride?: string;
  /** Profile-specific tool subset (passed through to transport) */
  allowedTools?: string[];
}

interface AgentContext {
  agentId: string;
  connectionId: ConnectionId;
  sessionId: SessionId;
  monitorId?: string;
}

const agentContext = new AsyncLocalStorage<AgentContext>();

export function getAgentId(): string | undefined {
  return agentContext.getStore()?.agentId;
}

export function getCurrentConnectionId(): ConnectionId | undefined {
  return agentContext.getStore()?.connectionId;
}

export function getSessionId(): SessionId | undefined {
  return agentContext.getStore()?.sessionId;
}

export function getMonitorId(): string | undefined {
  return agentContext.getStore()?.monitorId;
}

/**
 * Run a function within a specific agent context.
 * Used to restore agent identity from HTTP headers (e.g., X-Agent-Id in MCP requests).
 */
export function runWithAgentId<T>(agentId: string, fn: () => T): T {
  // Preserve existing connectionId/sessionId if available, otherwise use placeholders
  const existing = agentContext.getStore();
  return agentContext.run(
    {
      agentId,
      connectionId: existing?.connectionId ?? ('' as ConnectionId),
      sessionId: existing?.sessionId ?? ('' as SessionId),
    },
    fn,
  );
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
  private liveSessionId: SessionId;
  private provider: AITransport | null = null;
  private sessionId: string | null = null;
  private running = false;
  private sessionLogger: SessionLogger | null = null;
  private unsubscribeAction: (() => void) | null = null;
  private instanceId: string;
  private hasProcessedFirstUserTurn = false;
  private currentMessageId: string | null = null;
  private currentRole: string | null = null;
  private recordedActions: OSAction[] = [];
  private currentMonitorId: string | undefined;
  private onOutput: ((bytes: number) => void) | null = null;
  private broadcastFn: (event: ServerEvent) => void;

  private providerLifecycle: ProviderLifecycleManager;
  private toolActionBridge: ToolActionBridge;

  constructor(
    connectionId: ConnectionId,
    sessionId?: string,
    sharedLogger?: SessionLogger,
    instanceId?: string,
    liveSessionId?: SessionId,
    broadcast?: (event: ServerEvent) => void,
  ) {
    this.connectionId = connectionId;
    this.liveSessionId = liveSessionId ?? connectionId;
    this.broadcastFn = broadcast ?? (() => {});
    this.sessionId = sessionId ?? null;
    this.instanceId = instanceId ?? `agent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.sessionLogger = sharedLogger ?? null;

    // eslint-disable-next-line @typescript-eslint/no-this-alias
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
        get hasProcessedFirstUserTurn() {
          return connection.hasProcessedFirstUserTurn;
        },
        set hasProcessedFirstUserTurn(value: boolean) {
          connection.hasProcessedFirstUserTurn = value;
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
      {
        get currentRole() {
          return connection.currentRole;
        },
        get monitorId() {
          return connection.currentMonitorId;
        },
      },
      this.sendEvent.bind(this),
      this.getFilterAgentId.bind(this),
      () => this.sessionLogger,
      (action) => this.recordedActions.push(action),
    );
    this.unsubscribeAction = actionEmitter.onAction(
      this.toolActionBridge.handleToolAction.bind(this.toolActionBridge),
    );
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

  setOutputCallback(cb: ((bytes: number) => void) | null): void {
    this.onOutput = cb;
  }

  async initialize(preWarmedProvider?: AITransport): Promise<boolean> {
    return this.providerLifecycle.initialize(preWarmedProvider);
  }

  getSessionLogger(): SessionLogger | null {
    return this.sessionLogger;
  }

  async handleMessage(content: string, options: HandleMessageOptions): Promise<void> {
    const { role, interactions, messageId, onContextMessage } = options;

    this.currentRole = role;
    this.currentMonitorId = options.monitorId;
    const stableAgentId = this.instanceId;

    if (!this.provider) {
      return;
    }

    this.running = true;
    this.currentMessageId = messageId ?? null;
    this.recordedActions = [];

    await this.sendEvent({
      type: ServerEventType.AGENT_THINKING,
      content: '',
      agentId: role,
      monitorId: options.monitorId,
    });

    // Extract images from draw interactions for vision API
    const images =
      interactions?.filter((i) => i.type === 'draw' && i.imageData).map((i) => i.imageData!) ?? [];
    const fullContent = content;

    // Log user message with role identifier and source
    await this.sessionLogger?.logUserMessage(fullContent, role, options.source);
    onContextMessage?.('user', fullContent);

    try {
      // For forked sessions, use the parent's session ID so the provider can fork from it.
      // For resume, use the saved thread ID (only on first message).
      // Otherwise, resume our own session if we've already sent a message.
      let sessionIdToUse: string | undefined;
      let resumeThread = false;
      if (options.forkSession && options.parentSessionId) {
        sessionIdToUse = options.parentSessionId;
      } else if (options.resumeSessionId && !this.hasProcessedFirstUserTurn) {
        sessionIdToUse = options.resumeSessionId;
        resumeThread = true;
      } else if (this.hasProcessedFirstUserTurn && this.sessionId) {
        sessionIdToUse = this.sessionId;
      }

      const [memory, environment] = await Promise.all([
        loadMemory(),
        buildEnvironmentSection(this.provider.providerType),
      ]);
      const basePrompt = options.systemPromptOverride ?? this.provider.systemPrompt;
      const transportOptions: TransportOptions = {
        systemPrompt: basePrompt + environment + memory,
        sessionId: sessionIdToUse,
        forkSession: options.forkSession,
        resumeThread,
        images: images.length > 0 ? images : undefined,
        monitorId: options.monitorId,
        agentId: stableAgentId,
        allowedTools: options.allowedTools,
      };
      this.hasProcessedFirstUserTurn = true;

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
          // onSessionId callback - update session ID and log thread
          // Update internal provider session ID for session resumption/forking.
          // The log session ID (sent to frontend) is managed by ContextPool.
          this.sessionId = sessionId;
          const canonical = options.canonicalAgent;
          if (canonical) {
            try {
              await this.sessionLogger?.logThreadId(canonical, sessionId);
            } catch (err) {
              console.warn(`[AgentSession] Failed to persist thread ID for ${canonical}:`, err);
            }
          }
        },
        options.monitorId,
        this.onOutput ?? undefined,
      );

      console.log(
        `[AgentSession] ${role} starting query with content: "${fullContent.slice(0, 50)}..."`,
      );
      await agentContext.run(
        {
          agentId: stableAgentId,
          connectionId: this.connectionId,
          sessionId: this.liveSessionId,
          monitorId: options.monitorId,
        },
        async () => {
          console.log(`[AgentSession] ${role} entered agentContext.run`);
          for await (const message of this.provider!.query(fullContent, transportOptions)) {
            if (!this.running) break;
            await mapper.map(message);
          }
        },
      );
    } catch (err) {
      console.error(`[AgentSession] ${role} error:`, err);
      await this.sendEvent({
        type: ServerEventType.ERROR,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      // Always notify frontend that this agent is done.
      // When interrupted, the stream never emits a 'complete' message,
      // so the frontend would never clear the agent from the dashboard.
      // In the normal completion case this is a harmless no-op (clearAgent is idempotent).
      await this.sendEvent({
        type: ServerEventType.AGENT_RESPONSE,
        content: '',
        isComplete: true,
        agentId: role,
        monitorId: options.monitorId,
        messageId: messageId ?? undefined,
      });
      this.running = false;
      this.currentMessageId = null;
      this.currentRole = null;
    }
  }

  async steer(content: string): Promise<boolean> {
    if (!this.running || !this.provider?.steer) return false;
    return this.provider.steer(content);
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
    this.broadcastFn(event);
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
