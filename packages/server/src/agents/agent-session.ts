/**
 * AgentSession — manages a single AI provider session.
 *
 * Handles message sending, streaming, interruption, and provider lifecycle
 * for one agent. Role is assigned dynamically per-message via handleMessage options.
 */

import type {
  AITransport,
  InterruptReceipt,
  TransportOptions,
  TokenUsage,
} from '../providers/types.js';
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
import { ToolActionBridge } from './session-policies/tool-action-bridge.js';
import { acquireWarmProvider } from '../providers/factory.js';
import { runInAgentContext } from './agent-context.js';
import { principalRole } from './roles.js';
import { assembleSystemPromptForRole } from './system-prompt.js';
import { createLogger } from '../observability/log.js';

const log = createLogger('AgentSession');

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
  /**
   * The app this turn belongs to, for hooks that filter on one app's activity.
   *
   * Passed rather than read back off `role`: an app's per-turn role is
   * `app-{appId}-m{monitorId}-{messageId}` and both an app id and a message id may
   * contain the separator, so parsing it back is guesswork at the one place a wrong
   * answer would silently fire someone else's hook.
   */
  appId?: string;
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
  /**
   * The turn running on this session right now, or null. See {@link handleMessage}.
   *
   * Resolves — never rejects — when that turn has finished unwinding, so the next
   * caller can be chained behind it without inheriting its failure.
   */
  private turnInFlight: Promise<void> | null = null;

  /**
   * This agent's lifetime token consumption, across every turn it has run.
   *
   * Lives here rather than in the per-turn {@link StreamToEventMapper} because
   * that object is built and thrown away once per turn; a counter kept there
   * would reset on every message. Read by `AgentPool.listAgents()`, so it reaches
   * `yaar://session/agents` — and Process Explorer — without a second channel.
   */
  private usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };

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

  /** This agent's lifetime token consumption. A copy — callers must not mutate it. */
  getUsage(): TokenUsage {
    return { ...this.usage };
  }

  /**
   * Cost already banked from provider streams that have since been replaced, and
   * the last figure the current one reported. See {@link recordUsage}.
   */
  private costBankedUsd = 0;
  private costLastReportUsd = 0;

  /**
   * Fold one provider usage report into the lifetime total.
   *
   * The two scopes are not a style difference, they are what each provider
   * actually reports, and treating either as the other is silently wrong:
   * Claude's token figures cover only what has been spent since its last report
   * (add them), while Codex's `tokenUsage.total` is the thread's running total
   * re-sent several times per turn (replace with it, or the figure multiplies).
   *
   * `Math.max` on the replace path guards the one case where a running total can
   * appear to go backwards — a resumed or forked thread starts its own count
   * from zero — which would otherwise credit the agent a negative delta.
   *
   * `sessionCostUsd` obeys neither scope, which is why it is a separate
   * argument. Claude's `total_cost_usd` is the *session's* running cost even on
   * a message whose token figures are the turn's alone — measured at 0.0084 →
   * 0.0109 → 0.0137 across three turns — so adding it inflates the figure
   * quadratically. It is rebased instead: normally the newest report replaces
   * the last, and a report that has gone *backwards* means the provider stream
   * was reopened (a fresh CLI process counts from zero), so the previous
   * stream's final figure is banked and the new one accumulates on top.
   */
  recordUsage(
    usage: TokenUsage,
    scope: 'turn' | 'session',
    sessionCostUsd?: number,
  ): { total: TokenUsage; delta: TokenUsage } {
    const before = this.usage;
    if (sessionCostUsd !== undefined) {
      if (sessionCostUsd < this.costLastReportUsd) this.costBankedUsd += this.costLastReportUsd;
      this.costLastReportUsd = sessionCostUsd;
    }
    const costUsd = this.costBankedUsd + this.costLastReportUsd;
    const next: TokenUsage =
      scope === 'turn'
        ? {
            inputTokens: before.inputTokens + usage.inputTokens,
            outputTokens: before.outputTokens + usage.outputTokens,
            cacheReadTokens: before.cacheReadTokens + usage.cacheReadTokens,
            cacheWriteTokens: before.cacheWriteTokens + usage.cacheWriteTokens,
            costUsd,
          }
        : {
            inputTokens: Math.max(before.inputTokens, usage.inputTokens),
            outputTokens: Math.max(before.outputTokens, usage.outputTokens),
            cacheReadTokens: Math.max(before.cacheReadTokens, usage.cacheReadTokens),
            cacheWriteTokens: Math.max(before.cacheWriteTokens, usage.cacheWriteTokens),
            costUsd,
          };
    if (next.costUsd === undefined || next.costUsd === 0) delete next.costUsd;
    this.usage = next;
    return {
      total: { ...next },
      delta: {
        inputTokens: next.inputTokens - before.inputTokens,
        outputTokens: next.outputTokens - before.outputTokens,
        cacheReadTokens: next.cacheReadTokens - before.cacheReadTokens,
        cacheWriteTokens: next.cacheWriteTokens - before.cacheWriteTokens,
      },
    };
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

  /**
   * Attach this agent's provider — the pool's warm one, or a fresh one from the factory.
   *
   * Acquire and attach is *all* this does. It used to also mint a `SessionLogger` and emit
   * `CONNECTION_STATUS`, duplicating both from `ContextPool.initialize()`: the log mint
   * created a second `session_logs/` directory for a session that already had one, and the
   * status event went out with no `sessionId` on it — the exact hazard `ContextPool` names
   * at its own emit, where the client adopting the wrong id left every app it launched
   * holding a token for a session the hub does not hold. Two owners for one fact is one
   * too many, and the pool is the owner: it knows both ids and mints the log once.
   */
  async initialize(preWarmedProvider?: AITransport): Promise<boolean> {
    this.provider = preWarmedProvider ?? (await acquireWarmProvider());
    if (!this.provider) {
      await this.sendEvent({
        type: ServerEventType.ERROR,
        error: 'No AI provider available. Install Claude CLI.',
      });
      return false;
    }
    return true;
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
      log.warn('prewarm failed, first turn will cold-start', { err });
    }
  }

  /**
   * Run one turn. One session, one provider, one turn — a second caller waits.
   *
   * Callers are supposed to serialize: the monitor queue, the window queue's
   * is-processing flag, and the session processor each admit one turn at a time. But
   * every piece of per-turn state on this class is a single field — `running`,
   * `interrupted`, `currentRole`, `currentMessageId`, `recordedActions` — and the
   * provider's stream is one stream, so a caller race did not degrade, it corrupted:
   * two overlapping turns shared `running`, and the *first* one's `finally` cleared it
   * under the second, whose read loop (`if (!this.running) break`) then stopped at its
   * next message and answered with silence. The same flag going the other way brought
   * the interrupted turn back to life, so a window the user had just closed got its
   * cancelled answer anyway.
   *
   * The race that found this: closing an app window interrupts its agent and clears the
   * window queue's flag, but `interrupt()` returns when the *provider* has stopped, not
   * when the turn has unwound — so a re-invoke landing in between started turn two on an
   * agent still finishing turn one (`AppTaskProcessor.handleWindowClose`). That door is
   * shut on its own side; this is the invariant, kept where the state actually lives, so
   * the next caller to race cannot silently lose a turn.
   */
  async handleMessage(content: string, options: HandleMessageOptions): Promise<void> {
    const previous = this.turnInFlight;
    let settle!: () => void;
    const mine = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.turnInFlight = mine;

    if (previous) {
      log.warn('turn arrived while another was still running; waiting rather than overlapping', {
        instanceId: this.instanceId,
        role: options.role,
      });
      await previous;
    }

    try {
      await this.runTurn(content, options);
    } finally {
      settle();
      if (this.turnInFlight === mine) this.turnInFlight = null;
    }
  }

  private async runTurn(content: string, options: HandleMessageOptions): Promise<void> {
    const { role, interactions, messageId, onContextMessage } = options;

    this.currentRole = role;
    this.currentMonitorId = options.monitorId;
    const stableAgentId = this.instanceId;

    if (!this.provider) {
      return;
    }

    this.setRunning(true);
    this.interrupted = false;
    // A new turn is not the interrupted one: lift the emitter's block, or this
    // agent would never paint again after its first stop.
    actionEmitter.clearInterrupted(stableAgentId);
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
              log.warn('failed to persist thread id', { canonical, err });
            }
          }
        },
        monitorId: options.monitorId,
        appId: options.appId,
        onOutput: this.onOutput ?? undefined,
        agentInstanceId: stableAgentId,
        streamSessionId: this.liveSessionId,
        onUsage: (usage, scope, sessionCostUsd) => this.recordUsage(usage, scope, sessionCostUsd),
      });
      mapper = turnMapper;

      // A char count, not a sample. This used to log `content.slice(0, 50)`, which put
      // the opening of every user prompt into the operational log — a different file,
      // a different retention, and a different audience than `SessionLogger`, which is
      // where content is supposed to live.
      log.info('starting query', { role, contentChars: fullContent.length });
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
          log.debug('entered agent context', { role });
          for await (const message of this.provider!.query(fullContent, transportOptions)) {
            if (!this.running) break;
            await turnMapper.map(message);
          }
        },
      );
    } catch (err) {
      log.error('turn failed', { role, err });
      // Terminal for stream observers too — a throw ends the turn as surely as a
      // provider `error` message does. Latched, so the `finish` below won't add
      // a second close after it.
      mapper?.fail(errMessage(err));
      await this.sendEvent({
        type: ServerEventType.ERROR,
        error: errMessage(err),
      });
    } finally {
      // The live text feed is coalesced, so a turn that ends without a provider
      // `complete` — an interrupt, a throw — can be holding an unsent tail. Flush
      // before closing: `finish` is sync and terminal, and the client commits what
      // it has to CLI history on the isComplete below.
      await mapper?.flushResponse();
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

  /**
   * Stop this agent's turn, and resolve only once it is actually stopped.
   *
   * Three things have to happen, in this order, and the order is the fix:
   *
   * 1. `running = false` stops *us* — the turn loop breaks at its next message,
   *    so nothing further is mapped into events or context.
   * 2. The agent is marked interrupted with the action emitter. Steps 1 and 3
   *    say nothing about tool calls already dispatched: those run to completion
   *    on the MCP server and emit their actions through a path that never looks
   *    at this session. Without the mark, a `window.create` issued a beat before
   *    the stop still opens a window after it — the user presses stop, the
   *    agent disappears from the dashboard, and the screen keeps changing.
   * 3. The provider is awaited. It, not us, knows whether the model stopped;
   *    `interrupt()` used to return here without waiting, which is why "stopped"
   *    could be reported while the CLI was still working through queued input.
   */
  async interrupt(): Promise<InterruptReceipt | undefined> {
    this.setRunning(false);
    this.interrupted = true;
    actionEmitter.markInterrupted(this.instanceId);
    if (!this.provider) return undefined;

    const receipt = await this.provider.interrupt();
    if (receipt.outcome === 'escalated') {
      const queued = receipt.stillQueued?.length ?? 0;
      log.warn('interrupt escalated to a hard stop', { instanceId: this.instanceId, queued });
    }
    return receipt;
  }

  private async sendEvent(event: ServerEvent): Promise<void> {
    this.broadcastFn(event);
  }

  async cleanup(): Promise<void> {
    // The emitter keeps interrupted agents by id; an agent that is gone can
    // neither emit nor be un-marked by a next turn, so drop the entry with it.
    actionEmitter.clearInterrupted(this.instanceId);
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
