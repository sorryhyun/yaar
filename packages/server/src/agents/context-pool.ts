/**
 * ContextPool - Unified task orchestration with main agent + callbacks architecture.
 *
 * Routes tasks to agents via AgentPool:
 * - Main tasks: main agent (idle) or ephemeral agent (busy) — sequential queue
 * - Window tasks: persistent per-window agents — parallel across windows, sequential within
 * - InteractionTimeline: user interactions and agent actions accumulated, drained on main agent's next turn
 * - ContextTape: kept for logging/debugging and providing initial context to new window agents
 */

import { ContextTape, type ContextMessage, type ContextSource } from './context.js';
import { AgentPool, type PooledAgent } from './agent-pool.js';
import { InteractionTimeline } from './interaction-timeline.js';
import type { ServerEvent, UserInteraction } from '@yaar/shared';
import { createSession, SessionLogger } from '../logging/index.js';
import { getBroadcastCenter, type ConnectionId } from '../websocket/broadcast-center.js';
import { getAgentLimiter } from './limiter.js';
import { acquireWarmProvider, getWarmPool } from '../providers/factory.js';
import type { WindowStateRegistry } from '../mcp/window-state.js';
import type { ReloadCache } from '../reload/cache.js';
import { MainQueuePolicy } from './context-pool-policies/main-queue-policy.js';
import { WindowQueuePolicy } from './context-pool-policies/window-queue-policy.js';
import { ContextAssemblyPolicy } from './context-pool-policies/context-assembly-policy.js';
import { ReloadCachePolicy } from './context-pool-policies/reload-cache-policy.js';
import { WindowConnectionPolicy } from './context-pool-policies/window-connection-policy.js';

const MAX_QUEUE_SIZE = 10;

/**
 * A task to be processed by the pool.
 */
export interface Task {
  type: 'main' | 'window';
  messageId: string;
  windowId?: string;
  content: string;
  interactions?: UserInteraction[];
  actionId?: string; // For parallel button actions
}

/**
 * ContextPool manages task orchestration with a persistent main agent,
 * ephemeral overflow agents, and persistent per-window agents.
 */
export class ContextPool {
  private connectionId: ConnectionId;
  private agentPool: AgentPool;
  private contextTape: ContextTape;
  private timeline: InteractionTimeline;
  private sharedLogger: SessionLogger | null = null;
  private windowState: WindowStateRegistry;

  // Window task tracking
  private windowAgentMap: Map<string, string> = new Map();
  private mainQueuePolicy = new MainQueuePolicy(MAX_QUEUE_SIZE);
  private windowQueuePolicy = new WindowQueuePolicy();
  private contextAssembly = new ContextAssemblyPolicy();
  private reloadPolicy: ReloadCachePolicy;
  private windowConnectionPolicy = new WindowConnectionPolicy();
  private logSessionId: string | null = null;
  private savedThreadIds?: Record<string, string>;

  // Inflight task tracking for clean reset/cleanup
  private resetting = false;
  private inflightCount = 0;
  private inflightResolve: (() => void) | null = null;

  constructor(
    connectionId: ConnectionId,
    windowState: WindowStateRegistry,
    reloadCache: ReloadCache,
    restoredContext: ContextMessage[] = [],
    savedThreadIds?: Record<string, string>,
  ) {
    this.connectionId = connectionId;
    this.windowState = windowState;
    this.reloadPolicy = new ReloadCachePolicy(reloadCache);
    this.savedThreadIds = savedThreadIds;
    this.contextTape = new ContextTape();
    this.timeline = new InteractionTimeline();
    if (restoredContext.length > 0) {
      this.contextTape.restore(restoredContext);
      console.log(`[ContextPool] Restored ${restoredContext.length} context messages from previous session`);
    }
    this.agentPool = new AgentPool(connectionId);
  }

  /**
   * Initialize the pool with the main agent.
   */
  async initialize(): Promise<boolean> {
    const provider = await acquireWarmProvider();
    if (!provider) {
      await this.sendEvent({
        type: 'ERROR',
        error: 'No AI provider available. Install Claude CLI.',
      });
      return false;
    }

    const sessionInfo = await createSession(provider.name);
    this.sharedLogger = new SessionLogger(sessionInfo);
    this.logSessionId = sessionInfo.sessionId;
    this.agentPool.setLogger(this.sharedLogger);

    const mainAgent = await this.agentPool.createMainAgent(provider);
    if (!mainAgent) {
      await provider.dispose();
      return false;
    }

    await this.sendEvent({
      type: 'CONNECTION_STATUS',
      status: 'connected',
      provider: provider.name,
      sessionId: this.logSessionId,
    });

    return true;
  }

  // ── Inflight tracking ────────────────────────────────────────────────

  private inflightEnter(): void {
    this.inflightCount++;
  }

  private inflightExit(): void {
    this.inflightCount--;
    if (this.inflightCount <= 0 && this.inflightResolve) {
      this.inflightResolve();
      this.inflightResolve = null;
    }
  }

  private awaitInflight(): Promise<void> {
    if (this.inflightCount <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.inflightResolve = resolve;
    });
  }

  // ── Task routing ──────────────────────────────────────────────────────

  /**
   * Single entry point for all tasks.
   */
  async handleTask(task: Task): Promise<void> {
    if (this.resetting) {
      console.log(`[ContextPool] Rejecting task ${task.messageId} — pool is resetting`);
      return;
    }

    this.inflightEnter();
    try {
      if (task.type === 'main') {
        await this.queueMainTask(task);
      } else {
        await this.handleWindowTask(task);
      }
    } finally {
      this.inflightExit();
    }
  }

  // ── Main task processing ──────────────────────────────────────────────

  /**
   * Route a main task: to the main agent if idle, or to an ephemeral agent.
   */
  private async queueMainTask(task: Task): Promise<void> {
    if (!this.agentPool.isMainAgentBusy()) {
      // Main agent idle → process directly
      await this.processMainTask(this.agentPool.getMainAgent()!, task);
      return;
    }

    // Main agent busy → try ephemeral
    const ephemeral = await this.agentPool.createEphemeral();
    if (ephemeral) {
      await this.processEphemeralTask(ephemeral, task);
      return;
    }

    // No agents available → queue
    if (!this.mainQueuePolicy.canEnqueue()) {
      await this.sendEvent({
        type: 'ERROR',
        error: `Message queue is full (${MAX_QUEUE_SIZE} messages). Please wait for current operations to complete.`,
      });
      return;
    }

    const position = this.mainQueuePolicy.enqueue(task);
    console.log(`[ContextPool] Queued main task ${task.messageId}, queue size: ${position}`);

    await this.sendEvent({
      type: 'MESSAGE_QUEUED',
      messageId: task.messageId,
      position,
    });
  }

  /**
   * Process a main task on the main agent (provider session continuity).
   * Drains callback queue before processing.
   */
  private async processMainTask(agent: PooledAgent, task: Task): Promise<void> {
    agent.currentRole = `main-${task.messageId}`;
    agent.lastUsed = Date.now();

    await this.sendEvent({
      type: 'MESSAGE_ACCEPTED',
      messageId: task.messageId,
      agentId: `main-${task.messageId}`,
    });

    console.log(`[ContextPool] Processing main task ${task.messageId} with main agent ${agent.id}`);

    // Build prompt with callback injection
    const windowSnapshot = this.windowState.listWindows();
    const openWindowsContext = this.contextAssembly.formatOpenWindows(windowSnapshot.map(w => w.id));
    const fp = this.reloadPolicy.buildFingerprint(task, windowSnapshot);
    const reloadPrefix = this.reloadPolicy.formatReloadOptions(this.reloadPolicy.findMatches(fp, 3));
    const mainContext = this.contextAssembly.buildMainPrompt(task.content, {
      interactions: task.interactions,
      openWindows: openWindowsContext,
      reloadPrefix,
      timeline: this.timeline,
    });
    this.contextAssembly.appendUserMessage(this.contextTape, mainContext.contextContent, 'main');

    const resumeSessionId = this.savedThreadIds?.['default'];
    delete this.savedThreadIds?.['default'];

    await agent.session.handleMessage(mainContext.prompt, {
      role: agent.currentRole!,
      source: 'main',
      interactions: task.interactions,
      messageId: task.messageId,
      canonicalAgent: 'default',
      resumeSessionId,
      onContextMessage: (role, content) => {
        if (role === 'assistant') {
          this.contextAssembly.appendAssistantMessage(this.contextTape, content, 'main');
        }
      },
    });

    // Record actions for future cache hits
    const recordedActions = agent.session.getRecordedActions();
    this.reloadPolicy.maybeRecord(task, fp, recordedActions);

    agent.currentRole = null;
    await this.processMainQueue();
  }

  /**
   * Process a main task on an ephemeral agent (fresh provider, no context).
   * Pushes a callback when done, then disposes the agent.
   */
  private async processEphemeralTask(agent: PooledAgent, task: Task): Promise<void> {
    const ephemeralRole = `ephemeral-${task.messageId}`;
    agent.currentRole = ephemeralRole;
    agent.lastUsed = Date.now();

    await this.sendEvent({
      type: 'MESSAGE_ACCEPTED',
      messageId: task.messageId,
      agentId: ephemeralRole,
    });

    console.log(`[ContextPool] Processing main task ${task.messageId} with ephemeral agent ${agent.id}`);

    // Ephemeral agents get open windows + reload options + content, but NO callback prefix and NO conversation history
    const windowSnapshot = this.windowState.listWindows();
    const openWindowsContext = this.contextAssembly.formatOpenWindows(windowSnapshot.map(w => w.id));
    const fp = this.reloadPolicy.buildFingerprint(task, windowSnapshot);
    const reloadPrefix = this.reloadPolicy.formatReloadOptions(this.reloadPolicy.findMatches(fp, 3));
    const prompt = openWindowsContext + reloadPrefix + task.content;

    // Record user message to tape
    this.contextAssembly.appendUserMessage(this.contextTape, task.content, 'main');

    try {
      await agent.session.handleMessage(prompt, {
        role: ephemeralRole,
        source: 'main',
        interactions: task.interactions,
        messageId: task.messageId,
        onContextMessage: (role, content) => {
          if (role === 'assistant') {
            this.contextAssembly.appendAssistantMessage(this.contextTape, content, 'main');
          }
        },
      });

      // Record actions for cache + push callback
      const recordedActions = agent.session.getRecordedActions();
      this.reloadPolicy.maybeRecord(task, fp, recordedActions);

      this.timeline.pushAI(ephemeralRole, task.content.slice(0, 100), recordedActions);
    } finally {
      agent.currentRole = null;
      await this.agentPool.disposeEphemeral(agent);
    }
  }

  /**
   * Process queued main tasks when the main agent becomes available.
   */
  private async processMainQueue(): Promise<void> {
    if (!this.mainQueuePolicy.beginProcessing()) return;
    try {
      while (this.mainQueuePolicy.size() > 0) {
        if (this.agentPool.isMainAgentBusy()) break;

        const next = this.mainQueuePolicy.dequeue();
        if (next) await this.processMainTask(this.agentPool.getMainAgent()!, next.task);
      }
    } finally {
      this.mainQueuePolicy.endProcessing();
    }
  }

  // ── Window task processing ────────────────────────────────────────────

  private async handleWindowTask(task: Task): Promise<void> {
    if (!task.windowId) {
      console.error('[ContextPool] Window task missing windowId');
      return;
    }

    const windowId = task.windowId;

    // Resolve agent key: if this window belongs to a group, route to the group's agent
    const groupId = this.windowConnectionPolicy.getGroupId(windowId);
    const agentKey = groupId ?? windowId;
    const processingKey = task.actionId ?? agentKey;
    const isParallel = !!task.actionId;
    console.log(`[ContextPool] handleWindowTask: ${task.messageId} for ${windowId} (agentKey: ${agentKey}, key: ${processingKey}, parallel: ${isParallel})`);

    // Queue if this key is already busy (skip for parallel actions)
    if (!isParallel && this.windowQueuePolicy.isProcessing(processingKey)) {
      const queueSize = this.windowQueuePolicy.enqueue(processingKey, task);
      console.log(`[ContextPool] Queued task ${task.messageId} for ${processingKey}, queue size: ${queueSize}`);

      await this.sendEvent({
        type: 'MESSAGE_QUEUED',
        messageId: task.messageId,
        position: queueSize,
      });
      return;
    }

    this.windowQueuePolicy.setProcessing(processingKey, true);

    const agentRole = isParallel
      ? `window-${windowId}/${task.actionId}`
      : `window-${windowId}`;

    try {
      // Get or create persistent window agent — keyed by agentKey (groupId or windowId)
      const agent = await this.agentPool.getOrCreateWindowAgent(agentKey);
      if (!agent) {
        this.windowQueuePolicy.setProcessing(processingKey, false);
        console.error(`[ContextPool] Failed to create window agent for ${agentKey}`);
        await this.sendEvent({
          type: 'ERROR',
          error: `Failed to create agent for window ${windowId}`,
        });
        if (!isParallel) await this.processWindowQueue(processingKey);
        return;
      }

      agent.currentRole = agentRole;
      agent.lastUsed = Date.now();

      console.log(`[ContextPool] Agent ${agent.instanceId} assigned for window ${windowId} (agentKey: ${agentKey}, role: ${agentRole})`);

      await this.sharedLogger?.registerAgent(agentRole, 'default', windowId);
      await this.sendWindowStatus(windowId, agentRole, 'assigned');

      await this.sendEvent({
        type: 'MESSAGE_ACCEPTED',
        messageId: task.messageId,
        agentId: agentRole,
      });

      await this.sendWindowStatus(windowId, agentRole, 'active');

      // Compute fingerprint and check for reload matches
      const windowSnapshot = this.windowState.listWindows();
      const fp = this.reloadPolicy.buildFingerprint(task, windowSnapshot);
      const reloadPrefix = this.reloadPolicy.formatReloadOptions(this.reloadPolicy.findMatches(fp, 3));
      const openWindowsContext = this.contextAssembly.formatOpenWindows(windowSnapshot.map(w => w.id));
      const source: ContextSource = { window: windowId };

      // Record user message immediately
      this.contextAssembly.appendUserMessage(this.contextTape, task.content, source);

      // Build prompt: first interaction gets recent main context, subsequent get session continuity
      // canonicalAgent uses agentKey so the group shares one thread
      const canonicalWindow = `window-${agentKey}`;
      const resumeSessionId = this.savedThreadIds?.[canonicalWindow];
      delete this.savedThreadIds?.[canonicalWindow];

      let prompt: string;
      if (!resumeSessionId && agent.session.getRawSessionId() === null) {
        // First interaction: include recent main conversation context
        const recentContext = this.contextAssembly.buildWindowInitialContext(this.contextTape);
        prompt = recentContext + this.contextAssembly.buildWindowPrompt(task.content, {
          openWindows: openWindowsContext,
          reloadPrefix,
        });
      } else {
        // Subsequent interaction: session continuity, no extra context
        prompt = this.contextAssembly.buildWindowPrompt(task.content, {
          openWindows: openWindowsContext,
          reloadPrefix,
        });
      }

      await agent.session.handleMessage(prompt, {
        role: agentRole,
        source,
        interactions: task.interactions,
        messageId: task.messageId,
        canonicalAgent: canonicalWindow,
        resumeSessionId,
        onContextMessage: (role, content) => {
          if (role === 'assistant') {
            this.contextAssembly.appendAssistantMessage(this.contextTape, content, source);
          }
        },
      });

      // Record actions for future cache hits
      const recordedActions = agent.session.getRecordedActions();
      this.reloadPolicy.maybeRecord(task, fp, recordedActions, windowId);

      // Connect any child windows created by this window agent
      for (const action of recordedActions) {
        if (action.type === 'window.create') {
          this.windowConnectionPolicy.connectWindow(windowId, action.windowId);
          console.log(`[ContextPool] Connected child window ${action.windowId} to parent ${windowId} (group: ${this.windowConnectionPolicy.getGroupId(windowId)})`);
        }
      }

      // Push to timeline so main agent knows what happened
      this.timeline.pushAI(agentRole, task.content.slice(0, 100), recordedActions, windowId);

      agent.currentRole = null;
      await this.sendWindowStatus(windowId, agentRole, 'released');
    } finally {
      this.windowQueuePolicy.setProcessing(processingKey, false);
      if (!isParallel) await this.processWindowQueue(processingKey);
    }
  }

  private async processWindowQueue(windowId: string): Promise<void> {
    const next = this.windowQueuePolicy.dequeue(windowId);
    if (next) {
      console.log(`[ContextPool] Processing queued task ${next.task.messageId} for window ${windowId}`);
      await this.handleWindowTask(next.task);
    }
  }

  // ── Window lifecycle ───────────────────────────────────────────────────

  /**
   * Handle window close: dispose window agent, push callback, prune context.
   * Called by SessionManager when a window close action is processed.
   */
  handleWindowClose(windowId: string): void {
    // Resolve group BEFORE handleClose modifies it
    const groupId = this.windowConnectionPolicy.getGroupId(windowId);
    const agentKey = groupId ?? windowId;

    // Push to timeline about the window closing
    this.timeline.pushAI(`window-${windowId}`, `Window "${windowId}" closed`, [{ type: 'window.close', windowId }], windowId);

    // Update group state and decide if agent should be disposed
    const closeResult = this.windowConnectionPolicy.handleClose(windowId);

    if (closeResult.shouldDisposeAgent) {
      // Last window in group (or standalone) — dispose the agent
      this.agentPool.disposeWindowAgent(agentKey).catch((err) => {
        console.error(`[ContextPool] Error disposing window agent for ${agentKey}:`, err);
      });
    }
    // Agent survives if other windows remain in the group

    // Prune this window's context from tape (regardless of group status)
    const pruned = this.contextTape.pruneWindow(windowId);
    if (pruned.length > 0) {
      console.log(`[ContextPool] Pruned ${pruned.length} messages from closed window ${windowId}`);
    }

    // Clean up agent map entry for this window
    this.windowAgentMap.delete(windowId);
  }

  // ── Query methods ─────────────────────────────────────────────────────

  getContextTape(): ContextTape {
    return this.contextTape;
  }

  getTimeline(): InteractionTimeline {
    return this.timeline;
  }

  /**
   * Accumulate user interactions into the timeline for the main agent's next turn.
   * Skips 'draw' type interactions (handled separately as images).
   */
  pushUserInteractions(interactions: UserInteraction[]): void {
    for (const interaction of interactions) {
      if (interaction.type === 'draw') continue;
      this.timeline.pushUser(interaction);
    }
  }

  pruneWindowContext(windowId: string): void {
    const pruned = this.contextTape.pruneWindow(windowId);
    console.log(`[ContextPool] Pruned ${pruned.length} messages from window ${windowId}`);
  }

  getSessionLogger(): SessionLogger | null {
    return this.sharedLogger;
  }

  getPrimaryAgent(): import('./session.js').AgentSession | null {
    return this.agentPool.getMainAgentSession();
  }

  async interruptAll(): Promise<void> {
    await this.agentPool.interruptAll();
  }

  async reset(): Promise<void> {
    this.resetting = true;

    // 1. Clear queues so no new tasks start from dequeue
    this.mainQueuePolicy.clear();
    this.windowQueuePolicy.clear();

    // 2. Reject blocked limiter waiters so they unblock and exit
    getAgentLimiter().clearWaiting(new Error('Pool resetting'));

    // 3. Interrupt running queries so handleMessage loops exit
    await this.agentPool.interruptAll();

    // 4. Wait for all in-flight task functions to return
    await this.awaitInflight();

    // 5. Now safe to dispose agents (no in-flight references)
    await this.agentPool.cleanup();

    // 6. Stop shared Codex app-server so a fresh one is spawned
    await getWarmPool().resetCodexAppServer();

    // 7. Close all tracked windows on the frontend
    const openWindows = this.windowState.listWindows();
    if (openWindows.length > 0) {
      const closeActions = openWindows.map((win) => ({
        type: 'window.close' as const,
        windowId: win.id,
      }));
      await this.sendEvent({ type: 'ACTIONS', actions: closeActions });
    }

    // 7. Clear remaining state
    this.contextTape.clear();
    this.timeline.clear();
    this.windowAgentMap.clear();
    this.windowConnectionPolicy.clear();
    this.windowState.clear();

    // 8. Re-create a fresh main agent
    const provider = await acquireWarmProvider();
    if (provider) {
      const agent = await this.agentPool.createMainAgent(provider);
      if (agent) {
        await this.sendEvent({
          type: 'CONNECTION_STATUS',
          status: 'connected',
          provider: provider.name,
          sessionId: this.logSessionId ?? undefined,
        });
      } else {
        await provider.dispose();
      }
    }

    this.resetting = false;
    console.log(`[ContextPool] Reset: disposed agents, cleared context tape, timeline, queues, and window state`);
  }

  async interruptAgent(agentId: string): Promise<boolean> {
    return this.agentPool.interruptByRole(agentId);
  }

  hasActiveAgent(windowId: string): boolean {
    return this.agentPool.hasRolePrefix(`window-${windowId}`);
  }

  getWindowAgentId(windowId: string): string | undefined {
    return this.windowAgentMap.get(windowId);
  }

  getStats(): {
    totalAgents: number;
    idleAgents: number;
    busyAgents: number;
    mainQueueSize: number;
    windowQueueSizes: Record<string, number>;
    contextTapeSize: number;
    timelineSize: number;
    mainAgent: boolean;
    windowAgents: number;
    ephemeralAgents: number;
  } {
    const poolStats = this.agentPool.getStats();
    const windowQueueSizes = this.windowQueuePolicy.getQueueSizes();
    return {
      ...poolStats,
      mainQueueSize: this.mainQueuePolicy.size(),
      windowQueueSizes,
      contextTapeSize: this.contextTape.length,
      timelineSize: this.timeline.size,
    };
  }

  // ── Events ────────────────────────────────────────────────────────────

  private async sendWindowStatus(
    windowId: string,
    agentId: string,
    status: 'assigned' | 'active' | 'released',
  ): Promise<void> {
    this.windowAgentMap.set(windowId, agentId);
    await this.sendEvent({
      type: 'WINDOW_AGENT_STATUS',
      windowId,
      agentId,
      status,
    });
  }

  private async sendEvent(event: ServerEvent): Promise<void> {
    getBroadcastCenter().publishToConnection(event, this.connectionId);
  }

  // ── Cleanup ───────────────────────────────────────────────────────────

  async cleanup(): Promise<void> {
    this.resetting = true;
    this.mainQueuePolicy.clear();
    this.windowQueuePolicy.clear();
    getAgentLimiter().clearWaiting(new Error('Pool cleaning up'));
    await this.agentPool.interruptAll();
    await this.awaitInflight();
    await this.agentPool.cleanup();

    // Close all tracked windows on the frontend
    const openWindows = this.windowState.listWindows();
    if (openWindows.length > 0) {
      const closeActions = openWindows.map((win) => ({
        type: 'window.close' as const,
        windowId: win.id,
      }));
      await this.sendEvent({ type: 'ACTIONS', actions: closeActions });
    }

    this.windowAgentMap.clear();
    this.windowConnectionPolicy.clear();
    this.windowState.clear();
    this.contextTape.clear();
    this.timeline.clear();
    this.sharedLogger = null;
    this.resetting = false;
  }
}
