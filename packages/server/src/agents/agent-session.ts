/**
 * AgentSession — manages a single AI provider session.
 *
 * Handles message sending, streaming, interruption, and provider lifecycle
 * for one agent. Role is assigned dynamically per-message via handleMessage options.
 */

import type { AITransport, TransportOptions, ProviderType } from '../providers/types.js';
import {
  ServerEventType,
  type ServerEvent,
  type UserInteraction,
  type OSAction,
} from '@yaar/shared';
import type { SessionLogger } from '../logging/index.js';
import { actionEmitter } from '../session/action-emitter.js';
import { notifyAgentsChanged } from '../http/subscriptions.js';
import type { ConnectionId } from '../session/broadcast-center.js';
import type { SessionId } from '../session/types.js';
import type { ContextSource } from './context.js';
import { genId } from '../lib/ids.js';
import { errMessage } from '../lib/errors.js';
import { StreamToEventMapper } from './session-policies/stream-to-event-mapper.js';
import { ProviderLifecycleManager } from './session-policies/provider-lifecycle-manager.js';
import { ToolActionBridge } from './session-policies/tool-action-bridge.js';
import { runInAgentContext, principalRole } from './agent-context.js';
import { assembleSystemPromptForRole } from './system-prompt.js';

/**
 * Options for handling a message with dynamic role assignment.
 */
export interface HandleMessageOptions {
  /** Role to use for this message ('monitor-{messageId}' or 'window-{id}') */
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
  /** Override the model for this turn (e.g. from app.json agentType) */
  model?: string;
  /** Window ID for app agent tool resolution (set in AsyncLocalStorage context) */
  windowId?: string;
}

export class AgentSession {
  private connectionId: ConnectionId;
  private liveSessionId: SessionId;
  private provider: AITransport | null = null;
  private sessionId: string | null = null;
  private running = false;
  /**
   * True when the current turn was interrupted (e.g. "stop all"). Reset at the
   * start of every turn. `running` can't distinguish interruption inside a
   * post-turn callback because it's cleared for normal completion too, so
   * post-turn side effects (response hooks, relays) check this instead.
   */
  private interrupted = false;
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
    resolveWindowHandle?: (rawId: string, monitorId?: string) => string,
  ) {
    this.connectionId = connectionId;
    this.liveSessionId = liveSessionId ?? connectionId;
    this.broadcastFn = broadcast ?? (() => {});
    this.sessionId = sessionId ?? null;
    this.instanceId = instanceId ?? genId('agent');
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
        sessionId: this.liveSessionId,
      },
      this.sendEvent.bind(this),
      this.getFilterAgentId.bind(this),
      () => this.sessionLogger,
      (action) => this.recordedActions.push(action),
      resolveWindowHandle,
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

  /**
   * Flip the busy flag, waking anything subscribed to yaar://session/agents on
   * a real transition (Process Explorer renders busy/idle from it). Interrupt
   * and the post-turn `finally` both clear it, so no-op writes stay silent.
   */
  private setRunning(value: boolean): void {
    if (this.running === value) return;
    this.running = value;
    notifyAgentsChanged(this.liveSessionId);
  }

  /** True if the most recent turn was interrupted (stays true through the post-turn callbacks). */
  wasInterrupted(): boolean {
    return this.interrupted;
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

  /** Full system prompt for a turn: profile base + scope + environment + memory. */
  private async assembleSystemPrompt(
    role: string,
    monitorId?: string,
    systemPromptOverride?: string,
  ): Promise<string> {
    const basePrompt = systemPromptOverride ?? this.provider!.systemPrompt;
    return assembleSystemPromptForRole(basePrompt, role, this.provider!.providerType, monitorId);
  }

  /**
   * Pre-open the provider's persistent stream with the same options the first
   * real turn will use, so that turn starts on a live process with MCP tools
   * already connected. No-op for providers without prewarm support.
   */
  async prewarm(
    role: string,
    options: {
      monitorId?: string;
      systemPromptOverride?: string;
      allowedTools?: string[];
      model?: string;
    } = {},
  ): Promise<void> {
    if (!this.provider?.prewarm) return;
    try {
      await this.provider.prewarm({
        systemPrompt: await this.assembleSystemPrompt(
          role,
          options.monitorId,
          options.systemPromptOverride,
        ),
        agentId: this.instanceId,
        allowedTools: options.allowedTools,
        model: options.model,
        monitorId: options.monitorId,
      });
    } catch (err) {
      console.warn('[AgentSession] prewarm failed (first turn will cold-start):', err);
    }
  }

  async handleMessage(content: string, options: HandleMessageOptions): Promise<void> {
    const { role, interactions, messageId, onContextMessage } = options;

    this.currentRole = role;
    this.currentMonitorId = options.monitorId;
    const stableAgentId = this.instanceId;

    if (!this.provider) {
      return;
    }

    this.setRunning(true);
    this.interrupted = false;
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
    this.sessionLogger?.logUserMessage(fullContent, role, options.source);
    onContextMessage?.('user', fullContent);

    // Hoisted so `catch`/`finally` can close the observed turn. The stream's
    // `done` must be published even on the paths where no provider message ever
    // arrives — an interrupt, an abort, a throw — or a subscriber stays stuck in
    // `responding` for the rest of the session.
    let mapper: StreamToEventMapper | null = null;

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

      const transportOptions: TransportOptions = {
        systemPrompt: await this.assembleSystemPrompt(
          role,
          options.monitorId,
          options.systemPromptOverride,
        ),
        sessionId: sessionIdToUse,
        forkSession: options.forkSession,
        resumeThread,
        images: images.length > 0 ? images : undefined,
        monitorId: options.monitorId,
        agentId: stableAgentId,
        allowedTools: options.allowedTools,
        model: options.model,
      };
      this.hasProcessedFirstUserTurn = true;

      const streamState = {
        responseText: '',
        thinkingText: '',
        currentMessageId: this.currentMessageId,
      };

      const turnMapper = new StreamToEventMapper({
        role,
        providerName: this.provider.name,
        state: streamState,
        sendEvent: this.sendEvent.bind(this),
        logger: this.sessionLogger,
        source: options.source,
        onContextMessage,
        onSessionId: async (sessionId: string) => {
          // onSessionId callback - update session ID and log thread
          // Update internal provider session ID for session resumption/forking.
          // The log session ID (sent to frontend) is managed by ContextPool.
          this.sessionId = sessionId;
          const canonical = options.canonicalAgent;
          if (canonical) {
            try {
              this.sessionLogger?.logThreadId(canonical, sessionId);
            } catch (err) {
              console.warn(`[AgentSession] Failed to persist thread ID for ${canonical}:`, err);
            }
          }
        },
        monitorId: options.monitorId,
        onOutput: this.onOutput ?? undefined,
        agentInstanceId: stableAgentId,
        streamSessionId: this.liveSessionId,
      });
      mapper = turnMapper;

      console.log(
        `[AgentSession] ${role} starting query with content: "${fullContent.slice(0, 50)}..."`,
      );
      // Open the observed turn before the first provider message, so a stream
      // subscriber can clear last turn's state rather than appending to it.
      turnMapper.start();
      await runInAgentContext(
        {
          agentId: stableAgentId,
          connectionId: this.connectionId,
          sessionId: this.liveSessionId,
          monitorId: options.monitorId,
          windowId: options.windowId,
          role: principalRole(role),
        },
        async () => {
          console.log(`[AgentSession] ${role} entered agentContext.run`);
          for await (const message of this.provider!.query(fullContent, transportOptions)) {
            if (!this.running) break;
            await turnMapper.map(message);
          }
        },
      );
    } catch (err) {
      console.error(`[AgentSession] ${role} error:`, err);
      // Terminal for stream observers too — a throw ends the turn as surely as a
      // provider `error` message does. Latched, so the `finish` below won't add
      // a second close after it.
      mapper?.fail(errMessage(err));
      await this.sendEvent({
        type: ServerEventType.ERROR,
        error: errMessage(err),
      });
    } finally {
      // The guaranteed close. A no-op on the clean path (the provider's
      // `complete` already latched it) and the only close on the interrupt path,
      // where the provider stream stops without a terminal message.
      mapper?.finish(this.interrupted ? 'interrupted' : 'completed');
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
      this.setRunning(false);
      this.currentMessageId = null;
      this.currentRole = null;
    }
  }

  async steer(content: string): Promise<boolean> {
    if (!this.running || !this.provider?.steer) return false;
    return this.provider.steer(content);
  }

  async interrupt(): Promise<void> {
    this.setRunning(false);
    this.interrupted = true;
    this.provider?.interrupt();
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
