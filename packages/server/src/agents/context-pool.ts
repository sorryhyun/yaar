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
import type { ServerEvent, UserInteraction, OSAction } from '@yaar/shared';
import type { ProviderType } from '../providers/types.js';
import { createSession, SessionLogger } from '../logging/index.js';
import { getBroadcastCenter } from '../session/broadcast-center.js';
import type { SessionId } from '../session/types.js';
import { getAgentLimiter } from './limiter.js';
import { acquireWarmProvider, getWarmPool } from '../providers/factory.js';
import type { WindowStateRegistry } from '../mcp/window-state.js';
import type { ReloadCache } from '../reload/cache.js';
import { MainQueuePolicy } from './context-pool-policies/main-queue-policy.js';
import { WindowQueuePolicy } from './context-pool-policies/window-queue-policy.js';
import { ContextAssemblyPolicy } from './context-pool-policies/context-assembly-policy.js';
import { ReloadCachePolicy } from './context-pool-policies/reload-cache-policy.js';
import { WindowConnectionPolicy } from './context-pool-policies/window-connection-policy.js';
import { MonitorBudgetPolicy } from './context-pool-policies/monitor-budget-policy.js';
import { getProfile, ORCHESTRATOR_PROFILE } from './profiles.js';

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
  monitorId?: string; // Which monitor this task belongs to
}

/**
 * ContextPool manages task orchestration with a persistent main agent,
 * ephemeral overflow agents, and persistent per-window agents.
 */
export class ContextPool {
  private sessionId: SessionId;
  private agentPool: AgentPool;
  private contextTape: ContextTape;
  private timeline: InteractionTimeline;
  private sharedLogger: SessionLogger | null = null;
  private windowState: WindowStateRegistry;

  // Window task tracking
  private windowAgentMap: Map<string, string> = new Map();
  private mainQueues = new Map<string, MainQueuePolicy>();
  private windowQueuePolicy = new WindowQueuePolicy();
  private contextAssembly = new ContextAssemblyPolicy();
  private reloadPolicy: ReloadCachePolicy;
  private windowConnectionPolicy = new WindowConnectionPolicy();
  private budgetPolicy = new MonitorBudgetPolicy();
  private logSessionId: string | null = null;
  private savedThreadIds?: Record<string, string>;
  private providerType: ProviderType | null = null;

  // Inflight task tracking for clean reset/cleanup
  private resetting = false;
  private inflightCount = 0;
  private inflightResolve: (() => void) | null = null;

  constructor(
    sessionId: SessionId,
    windowState: WindowStateRegistry,
    reloadCache: ReloadCache,
    restoredContext: ContextMessage[] = [],
    savedThreadIds?: Record<string, string>,
  ) {
    this.sessionId = sessionId;
    this.windowState = windowState;
    this.reloadPolicy = new ReloadCachePolicy(reloadCache);
    this.savedThreadIds = savedThreadIds;
    this.contextTape = new ContextTape();
    this.timeline = new InteractionTimeline();
    if (restoredContext.length > 0) {
      this.contextTape.restore(restoredContext);
      console.log(
        `[ContextPool] Restored ${restoredContext.length} context messages from previous session`,
      );
    }
    this.agentPool = new AgentPool(sessionId);
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

    this.providerType = provider.providerType;
    const sessionInfo = await createSession(provider.name);
    this.sharedLogger = new SessionLogger(sessionInfo);
    this.logSessionId = sessionInfo.sessionId;
    this.agentPool.setLogger(this.sharedLogger);

    const mainAgent = await this.agentPool.createMainAgent('monitor-0', provider);
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

  /**
   * Get or create a MainQueuePolicy for a monitor.
   */
  private getOrCreateMainQueue(monitorId: string): MainQueuePolicy {
    let queue = this.mainQueues.get(monitorId);
    if (!queue) {
      queue = new MainQueuePolicy(MAX_QUEUE_SIZE);
      this.mainQueues.set(monitorId, queue);
    }
    return queue;
  }

  /**
   * Create a new main agent for a monitor (called when new monitor is created).
   */
  async createMonitorAgent(monitorId: string): Promise<boolean> {
    const provider = await acquireWarmProvider();
    if (!provider) {
      await this.sendEvent({
        type: 'ERROR',
        error: 'No AI provider available for new monitor.',
        monitorId,
      });
      return false;
    }

    const agent = await this.agentPool.createMainAgent(monitorId, provider);
    if (!agent) {
      await provider.dispose();
      await this.sendEvent({
        type: 'ERROR',
        error: 'Agent limit reached. Cannot create new monitor.',
        monitorId,
      });
      return false;
    }

    console.log(`[ContextPool] Created monitor agent for ${monitorId}`);
    return true;
  }

  /**
   * Check if a main agent exists for the given monitor.
   */
  hasMainAgent(monitorId: string): boolean {
    return this.agentPool.hasMainAgent(monitorId);
  }

  /**
   * Return the number of active main agents (one per monitor).
   */
  getMainAgentCount(): number {
    return this.agentPool.getMainAgentCount();
  }

  /**
   * Remove a monitor's main agent and clean up associated resources.
   * Called when a monitor is deleted from the frontend.
   */
  async removeMonitorAgent(monitorId: string): Promise<void> {
    // Remove the main queue for this monitor
    const queue = this.mainQueues.get(monitorId);
    if (queue) {
      queue.clear();
      this.mainQueues.delete(monitorId);
    }

    // Dispose the main agent and release limiter slot
    const removed = await this.agentPool.removeMainAgent(monitorId);
    if (removed) {
      console.log(`[ContextPool] Removed monitor agent for ${monitorId}`);
    }
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
    const monitorId = task.monitorId ?? 'monitor-0';

    // Acquire budget slot for background monitors (blocks until available)
    await this.budgetPolicy.acquireTaskSlot(monitorId);

    try {
      await this.queueMainTaskInner(task, monitorId);
    } finally {
      this.budgetPolicy.releaseTaskSlot(monitorId);
    }
  }

  private async queueMainTaskInner(task: Task, monitorId: string): Promise<void> {
    if (!this.agentPool.isMainAgentBusy(monitorId)) {
      // Main agent idle → process directly
      await this.processMainTask(this.agentPool.getMainAgent(monitorId)!, task);
      return;
    }

    // Main agent busy → try to steer the active turn (Codex mid-turn injection)
    const steered = await this.agentPool.steerMainAgent(monitorId, task.content);
    if (steered) {
      console.log(
        `[ContextPool] Steered active turn for ${monitorId} with message ${task.messageId}`,
      );
      this.contextAssembly.appendUserMessage(this.contextTape, task.content, 'main');
      const agent = this.agentPool.getMainAgent(monitorId)!;
      await this.sendEvent({
        type: 'MESSAGE_ACCEPTED',
        messageId: task.messageId,
        agentId: agent.currentRole!,
      });
      return;
    }

    // Steer not supported or failed → try ephemeral
    const ephemeral = await this.agentPool.createEphemeral();
    if (ephemeral) {
      await this.processEphemeralTask(ephemeral, task);
      return;
    }

    // No agents available → queue
    const queue = this.getOrCreateMainQueue(monitorId);
    if (!queue.canEnqueue()) {
      await this.sendEvent({
        type: 'ERROR',
        error: `Message queue is full (${MAX_QUEUE_SIZE} messages). Please wait for current operations to complete.`,
      });
      return;
    }

    const position = queue.enqueue(task);
    console.log(
      `[ContextPool] Queued main task ${task.messageId} for ${monitorId}, queue size: ${position}`,
    );

    await this.sendEvent({
      type: 'MESSAGE_QUEUED',
      messageId: task.messageId,
      position,
    });
  }

  /**
   * Record an OS action against a monitor's budget.
   * Interrupts the monitor's agent if the action budget is exceeded.
   */
  recordMonitorAction(monitorId: string): void {
    this.budgetPolicy.recordAction(monitorId);
    if (!this.budgetPolicy.checkActionBudget(monitorId)) {
      console.warn(
        `[ContextPool] Monitor ${monitorId} exceeded action budget — interrupting agent`,
      );
      const agent = this.agentPool.getMainAgent(monitorId);
      if (agent?.session.isRunning()) {
        agent.session.interrupt().catch((err) => {
          console.error(`[ContextPool] Failed to interrupt agent for ${monitorId}:`, err);
        });
      }
    }
  }

  /**
   * Process a main task on the main agent (provider session continuity).
   * Drains callback queue before processing.
   */
  private async processMainTask(agent: PooledAgent, task: Task): Promise<void> {
    const monitorId = task.monitorId ?? 'monitor-0';
    const mainRole = `main-${monitorId}-${task.messageId}`;
    agent.currentRole = mainRole;
    agent.lastUsed = Date.now();

    // Set output tracking callback for budget policy with output budget enforcement
    agent.session.setOutputCallback((bytes) => {
      this.budgetPolicy.recordOutput(monitorId, bytes);
      if (!this.budgetPolicy.checkOutputBudget(monitorId)) {
        console.warn(
          `[ContextPool] Monitor ${monitorId} exceeded output budget — interrupting agent`,
        );
        agent.session.interrupt().catch((err) => {
          console.error(`[ContextPool] Failed to interrupt agent for ${monitorId}:`, err);
        });
      }
    });

    await this.sendEvent({
      type: 'MESSAGE_ACCEPTED',
      messageId: task.messageId,
      agentId: mainRole,
    });

    console.log(
      `[ContextPool] Processing main task ${task.messageId} with main agent ${agent.id} (monitor: ${monitorId})`,
    );

    // Build prompt with callback injection
    const windowSnapshot = this.windowState.listWindows();
    const openWindowsContext = this.contextAssembly.formatOpenWindows(
      windowSnapshot.map((w) => w.id),
    );
    const fp = this.reloadPolicy.buildFingerprint(task, windowSnapshot);
    const reloadPrefix = this.reloadPolicy.formatReloadOptions(
      this.reloadPolicy.findMatches(fp, 3),
    );
    const mainContext = this.contextAssembly.buildMainPrompt(task.content, {
      interactions: task.interactions,
      openWindows: openWindowsContext,
      reloadPrefix,
      timeline: this.timeline,
    });
    this.contextAssembly.appendUserMessage(this.contextTape, mainContext.contextContent, 'main');

    const canonicalMain = `main-${monitorId}`;
    const resumeSessionId = this.savedThreadIds?.[canonicalMain];
    delete this.savedThreadIds?.[canonicalMain];

    await agent.session.handleMessage(mainContext.prompt, {
      role: agent.currentRole!,
      source: 'main',
      interactions: task.interactions,
      messageId: task.messageId,
      canonicalAgent: canonicalMain,
      resumeSessionId,
      monitorId,
      allowedTools: this.providerType === 'codex' ? undefined : ORCHESTRATOR_PROFILE.allowedTools,
      onContextMessage: (role, content) => {
        if (role === 'assistant') {
          this.contextAssembly.appendAssistantMessage(this.contextTape, content, 'main');
        }
      },
    });

    // Record actions for future cache hits
    const recordedActions = agent.session.getRecordedActions();
    this.reloadPolicy.maybeRecord(task, fp, recordedActions);

    agent.session.setOutputCallback(null);
    agent.currentRole = null;
    await this.processMainQueue(monitorId);
  }

  /**
   * Process a main task on an ephemeral agent (fresh provider, no context).
   * Pushes a callback when done, then disposes the agent.
   */
  private async processEphemeralTask(agent: PooledAgent, task: Task): Promise<void> {
    const monitorId = task.monitorId ?? 'monitor-0';
    const ephemeralRole = `ephemeral-${monitorId}-${task.messageId}`;
    agent.currentRole = ephemeralRole;
    agent.lastUsed = Date.now();

    // Set output tracking callback for budget policy with output budget enforcement
    agent.session.setOutputCallback((bytes) => {
      this.budgetPolicy.recordOutput(monitorId, bytes);
      if (!this.budgetPolicy.checkOutputBudget(monitorId)) {
        console.warn(
          `[ContextPool] Monitor ${monitorId} exceeded output budget — interrupting ephemeral agent`,
        );
        agent.session.interrupt().catch((err) => {
          console.error(`[ContextPool] Failed to interrupt ephemeral agent for ${monitorId}:`, err);
        });
      }
    });

    await this.sendEvent({
      type: 'MESSAGE_ACCEPTED',
      messageId: task.messageId,
      agentId: ephemeralRole,
    });

    console.log(
      `[ContextPool] Processing main task ${task.messageId} with ephemeral agent ${agent.id}`,
    );

    // Ephemeral agents get open windows + reload options + content, but NO callback prefix and NO conversation history
    const windowSnapshot = this.windowState.listWindows();
    const openWindowsContext = this.contextAssembly.formatOpenWindows(
      windowSnapshot.map((w) => w.id),
    );
    const fp = this.reloadPolicy.buildFingerprint(task, windowSnapshot);
    const reloadPrefix = this.reloadPolicy.formatReloadOptions(
      this.reloadPolicy.findMatches(fp, 3),
    );
    const prompt = openWindowsContext + reloadPrefix + task.content;

    // Record user message to tape
    this.contextAssembly.appendUserMessage(this.contextTape, task.content, 'main');

    try {
      await agent.session.handleMessage(prompt, {
        role: ephemeralRole,
        source: 'main',
        interactions: task.interactions,
        messageId: task.messageId,
        monitorId,
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
      agent.session.setOutputCallback(null);
      agent.currentRole = null;
      await this.agentPool.disposeEphemeral(agent);
    }
  }

  /**
   * Process queued main tasks when the main agent becomes available.
   */
  private async processMainQueue(monitorId = 'monitor-0'): Promise<void> {
    const queue = this.mainQueues.get(monitorId);
    if (!queue || !queue.beginProcessing()) return;
    try {
      while (queue.size() > 0) {
        if (this.agentPool.isMainAgentBusy(monitorId)) break;

        const next = queue.dequeue();
        if (next) await this.processMainTask(this.agentPool.getMainAgent(monitorId)!, next.task);
      }
    } finally {
      queue.endProcessing();
    }
  }

  // ── Task dispatch ────────────────────────────────────────────────────

  /**
   * Dispatch a task to a specialized agent.
   * The task agent forks the main agent's Claude session (inheriting full conversation context)
   * and runs with a profile-specific tool subset and system prompt.
   */
  async dispatchTask(options: {
    objective?: string;
    profile?: string;
    hint?: string;
    monitorId?: string;
    messageId?: string;
  }): Promise<{
    status: 'completed' | 'failed' | 'interrupted';
    summary: string;
    actions: { type: string; windowId?: string; title?: string }[];
    error?: string;
  }> {
    const monitorId = options.monitorId ?? 'monitor-0';
    const profile = getProfile(options.profile ?? 'default');

    // 1. Get main agent's session ID for forking
    const mainAgent = this.agentPool.getMainAgent(monitorId);
    const parentSessionId = mainAgent?.session.getRawSessionId() ?? undefined;

    // 2. Create task agent
    const taskAgent = await this.agentPool.createTaskAgent();
    if (!taskAgent) {
      return {
        status: 'failed',
        summary: '',
        actions: [],
        error: 'Agent limit reached — cannot create task agent.',
      };
    }

    const taskRole = `task-${options.messageId ?? Date.now()}-${Date.now()}`;
    taskAgent.currentRole = taskRole;

    // 3. Build prompt (minimal — fork carries context)
    const prompt = options.objective ?? 'Execute the user request.';

    // 4. Run with fork
    try {
      await taskAgent.session.handleMessage(prompt, {
        role: taskRole,
        source: 'main',
        forkSession: !!parentSessionId,
        parentSessionId,
        systemPromptOverride: profile.systemPrompt,
        allowedTools: profile.allowedTools,
        monitorId,
      });

      const actions = taskAgent.session.getRecordedActions();
      const summary = this.formatActionSummary(actions);
      this.timeline.pushAI(taskRole, options.hint ?? 'task', actions);

      return {
        status: 'completed',
        summary,
        actions: actions.map((a) => this.summarizeAction(a)),
      };
    } catch (err) {
      return {
        status: 'failed',
        summary: '',
        actions: [],
        error: String(err),
      };
    } finally {
      taskAgent.currentRole = null;
      await this.agentPool.disposeTaskAgent(taskAgent);
    }
  }

  private formatActionSummary(actions: OSAction[]): string {
    if (actions.length === 0) return 'No actions taken.';
    return (
      actions
        .map((a) => {
          switch (a.type) {
            case 'window.create':
              return `Created window "${a.windowId}"`;
            case 'window.close':
              return `Closed window "${a.windowId}"`;
            case 'window.setContent':
              return `Updated window "${a.windowId}"`;
            case 'window.setTitle':
              return `Set title of "${a.windowId}"`;
            case 'notification.show':
              return `Showed notification "${a.title}"`;
            default:
              return `Action: ${a.type}`;
          }
        })
        .join('. ') + '.'
    );
  }

  private summarizeAction(action: OSAction): { type: string; windowId?: string; title?: string } {
    const result: { type: string; windowId?: string; title?: string } = { type: action.type };
    if ('windowId' in action) result.windowId = action.windowId;
    if ('title' in action && typeof action.title === 'string') result.title = action.title;
    return result;
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
    console.log(
      `[ContextPool] handleWindowTask: ${task.messageId} for ${windowId} (agentKey: ${agentKey}, key: ${processingKey}, parallel: ${isParallel})`,
    );

    // Queue if this key is already busy (skip for parallel actions)
    if (!isParallel && this.windowQueuePolicy.isProcessing(processingKey)) {
      const queueSize = this.windowQueuePolicy.enqueue(processingKey, task);
      console.log(
        `[ContextPool] Queued task ${task.messageId} for ${processingKey}, queue size: ${queueSize}`,
      );

      await this.sendEvent({
        type: 'MESSAGE_QUEUED',
        messageId: task.messageId,
        position: queueSize,
      });
      return;
    }

    this.windowQueuePolicy.setProcessing(processingKey, true);

    const agentRole = isParallel ? `window-${windowId}/${task.actionId}` : `window-${windowId}`;

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

      console.log(
        `[ContextPool] Agent ${agent.instanceId} assigned for window ${windowId} (agentKey: ${agentKey}, role: ${agentRole})`,
      );

      await this.sharedLogger?.registerAgent(
        agentRole,
        `main-${task.monitorId ?? 'monitor-0'}`,
        windowId,
      );
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
      const reloadPrefix = this.reloadPolicy.formatReloadOptions(
        this.reloadPolicy.findMatches(fp, 3),
      );
      const openWindowsContext = this.contextAssembly.formatOpenWindows(
        windowSnapshot.map((w) => w.id),
      );
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
        prompt =
          recentContext +
          this.contextAssembly.buildWindowPrompt(task.content, {
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
          console.log(
            `[ContextPool] Connected child window ${action.windowId} to parent ${windowId} (group: ${this.windowConnectionPolicy.getGroupId(windowId)})`,
          );
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
      console.log(
        `[ContextPool] Processing queued task ${next.task.messageId} for window ${windowId}`,
      );
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

    // NOTE: No timeline entry pushed here.
    // - User-initiated closes are already in the timeline via pushUserInteractions()
    // - AI-initiated closes are already captured in recordedActions summaries
    //   from processEphemeralTask() or handleWindowTask()

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

  getPrimaryAgent(monitorId?: string): import('./session.js').AgentSession | null {
    return this.agentPool.getMainAgentSession(monitorId);
  }

  async interruptAll(): Promise<void> {
    await this.agentPool.interruptAll();
  }

  async reset(): Promise<void> {
    if (this.resetting) return;
    this.resetting = true;

    // Save active monitor IDs before clearing so we can recreate agents for all of them
    const activeMonitorIds = [...this.mainQueues.keys()];
    // Also include monitors that have agents but no queue yet
    for (const monitorId of this.agentPool.getMainAgentMonitorIds()) {
      if (!activeMonitorIds.includes(monitorId)) {
        activeMonitorIds.push(monitorId);
      }
    }
    // Ensure at least monitor-0 is present
    if (!activeMonitorIds.includes('monitor-0')) {
      activeMonitorIds.push('monitor-0');
    }

    // 1. Clear queues so no new tasks start from dequeue
    this.mainQueues.forEach((q) => q.clear());
    this.mainQueues.clear();
    this.windowQueuePolicy.clear();

    // 2. Reject blocked limiter/budget waiters so they unblock and exit
    getAgentLimiter().clearWaiting(new Error('Pool resetting'));
    this.budgetPolicy.clearWaiting(new Error('Pool resetting'));

    // 3. Interrupt running queries so handleMessage loops exit
    try {
      await this.agentPool.interruptAll();
    } catch (err) {
      console.error('[ContextPool] Reset: interruptAll failed:', err);
    }

    // 4. Wait for all in-flight task functions to return (with timeout)
    try {
      await Promise.race([
        this.awaitInflight(),
        new Promise<void>((resolve) => setTimeout(resolve, 30_000)),
      ]);
    } catch (err) {
      console.error('[ContextPool] Reset: awaitInflight failed:', err);
    }

    // 5. Now safe to dispose agents (no in-flight references)
    try {
      await this.agentPool.cleanup();
    } catch (err) {
      console.error('[ContextPool] Reset: agentPool.cleanup failed:', err);
    }

    // 6. Dispose pooled Codex providers (AppServer process stays alive)
    try {
      await getWarmPool().resetCodexProviders();
    } catch (err) {
      console.error('[ContextPool] Reset: resetCodexProviders failed:', err);
    }

    // 7. Close all tracked windows on the frontend
    const openWindows = this.windowState.listWindows();
    if (openWindows.length > 0) {
      const closeActions = openWindows.map((win) => ({
        type: 'window.close' as const,
        windowId: win.id,
      }));
      await this.sendEvent({ type: 'ACTIONS', actions: closeActions });
    }

    // 8. Clear remaining state (including saved thread IDs so we don't resume old sessions)
    this.contextTape.clear();
    this.timeline.clear();
    this.windowAgentMap.clear();
    this.windowConnectionPolicy.clear();
    this.windowState.clear();
    this.budgetPolicy.clear();
    this.savedThreadIds = undefined;

    // 9. Re-create fresh main agents for ALL previously active monitors
    for (const monitorId of activeMonitorIds) {
      const provider = await acquireWarmProvider();
      if (provider) {
        const agent = await this.agentPool.createMainAgent(monitorId, provider);
        if (agent) {
          if (monitorId === 'monitor-0') {
            await this.sendEvent({
              type: 'CONNECTION_STATUS',
              status: 'connected',
              provider: provider.name,
              sessionId: this.logSessionId ?? undefined,
            });
          }
        } else {
          await provider.dispose();
          console.warn(`[ContextPool] Reset: failed to recreate agent for ${monitorId}`);
        }
      } else {
        console.warn(`[ContextPool] Reset: no provider available for ${monitorId}`);
      }
    }

    this.resetting = false;
    console.log(
      `[ContextPool] Reset complete: recreated ${activeMonitorIds.length} monitor agent(s), cleared all state`,
    );
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
    taskAgents: number;
    monitorBudget: ReturnType<MonitorBudgetPolicy['getStats']>;
  } {
    const poolStats = this.agentPool.getStats();
    const windowQueueSizes = this.windowQueuePolicy.getQueueSizes();
    return {
      ...poolStats,
      mainQueueSize: Array.from(this.mainQueues.values()).reduce((sum, q) => sum + q.size(), 0),
      windowQueueSizes,
      contextTapeSize: this.contextTape.length,
      timelineSize: this.timeline.size,
      monitorBudget: this.budgetPolicy.getStats(),
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
    getBroadcastCenter().publishToSession(this.sessionId, event);
  }

  // ── Cleanup ───────────────────────────────────────────────────────────

  async cleanup(): Promise<void> {
    this.resetting = true;
    this.mainQueues.forEach((q) => q.clear());
    this.mainQueues.clear();
    this.windowQueuePolicy.clear();
    getAgentLimiter().clearWaiting(new Error('Pool cleaning up'));
    this.budgetPolicy.clear();
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
