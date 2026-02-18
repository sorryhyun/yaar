/**
 * ContextPool - Unified task orchestration facade.
 *
 * Routes tasks to agents via AgentPool:
 * - Main tasks: main agent (idle) or ephemeral agent (busy) — sequential queue
 * - Window tasks: persistent per-window agents — parallel across windows, sequential within
 * - InteractionTimeline: user interactions and agent actions accumulated, drained on main agent's next turn
 * - ContextTape: kept for logging/debugging and providing initial context to new window agents
 *
 * Processing logic is delegated to:
 * - MainTaskProcessor: main queue, ephemeral overflow, budget enforcement
 * - WindowTaskProcessor: window agents, window queue, window close lifecycle
 * - TaskDispatcher: forked task agents with profile-specific tools
 */

import { ContextTape, type ContextMessage } from './context.js';
import { AgentPool } from './agent-pool.js';
import { InteractionTimeline } from './interaction-timeline.js';
import { ServerEventType, type ServerEvent, type UserInteraction } from '@yaar/shared';
import type { ProviderType } from '../providers/types.js';
import { createSession, SessionLogger } from '../logging/index.js';
import type { SessionId } from '../session/types.js';
import { getAgentLimiter } from './limiter.js';
import { acquireWarmProvider, getWarmPool } from '../providers/factory.js';
import type { WindowStateRegistry } from '../mcp/window-state.js';
import type { ReloadCache } from '../reload/cache.js';
import {
  MainQueuePolicy,
  WindowQueuePolicy,
  ContextAssemblyPolicy,
  ReloadCachePolicy,
  WindowConnectionPolicy,
  MonitorBudgetPolicy,
} from './context-pool-policies/index.js';
import { MainTaskProcessor } from './main-task-processor.js';
import { WindowTaskProcessor } from './window-task-processor.js';
import { TaskDispatcher, type DispatchResult } from './task-dispatcher.js';
import type { PoolContext, Task } from './pool-context.js';

// Re-export Task for barrel compatibility
export type { Task } from './pool-context.js';

const MAX_QUEUE_SIZE = 10;

/**
 * ContextPool manages task orchestration with a persistent main agent,
 * ephemeral overflow agents, and persistent per-window agents.
 *
 * Implements PoolContext so processors can access shared state and policies.
 */
export class ContextPool implements PoolContext {
  private sessionId: SessionId;
  private logSessionId: string | null = null;

  // ── PoolContext fields (readonly for processors) ───────────────────
  readonly agentPool: AgentPool;
  readonly contextTape: ContextTape;
  readonly timeline: InteractionTimeline;
  readonly windowState: WindowStateRegistry;
  readonly contextAssembly = new ContextAssemblyPolicy();
  readonly reloadPolicy: ReloadCachePolicy;
  readonly windowQueuePolicy = new WindowQueuePolicy();
  readonly windowConnectionPolicy = new WindowConnectionPolicy();
  readonly budgetPolicy = new MonitorBudgetPolicy();
  readonly windowAgentMap: Map<string, string> = new Map();
  sharedLogger: SessionLogger | null = null;
  savedThreadIds?: Record<string, string>;
  providerType: ProviderType | null = null;

  // ── Internal state ────────────────────────────────────────────────
  private broadcastFn: (event: ServerEvent) => void;
  private mainQueues = new Map<string, MainQueuePolicy>();
  private resetting = false;
  private inflightCount = 0;
  private inflightResolve: (() => void) | null = null;

  // ── Processors ────────────────────────────────────────────────────
  private mainProcessor: MainTaskProcessor;
  private windowProcessor: WindowTaskProcessor;
  private dispatcher: TaskDispatcher;

  constructor(
    sessionId: SessionId,
    windowState: WindowStateRegistry,
    reloadCache: ReloadCache,
    broadcast: (event: ServerEvent) => void,
    restoredContext: ContextMessage[] = [],
    savedThreadIds?: Record<string, string>,
  ) {
    this.sessionId = sessionId;
    this.broadcastFn = broadcast;
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
    this.agentPool = new AgentPool(sessionId, broadcast);

    // Create processors
    this.mainProcessor = new MainTaskProcessor(this);
    this.windowProcessor = new WindowTaskProcessor(this);
    this.dispatcher = new TaskDispatcher(this);
  }

  // ── PoolContext methods ─────────────────────────────────────────────

  getOrCreateMainQueue(monitorId: string): MainQueuePolicy {
    let queue = this.mainQueues.get(monitorId);
    if (!queue) {
      queue = new MainQueuePolicy(MAX_QUEUE_SIZE);
      this.mainQueues.set(monitorId, queue);
    }
    return queue;
  }

  async sendEvent(event: ServerEvent): Promise<void> {
    this.broadcastFn(event);
  }

  // ── Initialization ─────────────────────────────────────────────────

  async initialize(): Promise<boolean> {
    const provider = await acquireWarmProvider();
    if (!provider) {
      await this.sendEvent({
        type: ServerEventType.ERROR,
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
      type: ServerEventType.CONNECTION_STATUS,
      status: 'connected',
      provider: provider.name,
      sessionId: this.logSessionId,
    });

    return true;
  }

  // ── Monitor lifecycle ──────────────────────────────────────────────

  async createMonitorAgent(monitorId: string): Promise<boolean> {
    const provider = await acquireWarmProvider();
    if (!provider) {
      await this.sendEvent({
        type: ServerEventType.ERROR,
        error: 'No AI provider available for new monitor.',
        monitorId,
      });
      return false;
    }

    const agent = await this.agentPool.createMainAgent(monitorId, provider);
    if (!agent) {
      await provider.dispose();
      await this.sendEvent({
        type: ServerEventType.ERROR,
        error: 'Agent limit reached. Cannot create new monitor.',
        monitorId,
      });
      return false;
    }

    console.log(`[ContextPool] Created monitor agent for ${monitorId}`);
    return true;
  }

  hasMainAgent(monitorId: string): boolean {
    return this.agentPool.hasMainAgent(monitorId);
  }

  getMainAgentCount(): number {
    return this.agentPool.getMainAgentCount();
  }

  async removeMonitorAgent(monitorId: string): Promise<void> {
    const queue = this.mainQueues.get(monitorId);
    if (queue) {
      queue.clear();
      this.mainQueues.delete(monitorId);
    }

    const removed = await this.agentPool.removeMainAgent(monitorId);
    if (removed) {
      console.log(`[ContextPool] Removed monitor agent for ${monitorId}`);
    }
  }

  // ── Inflight tracking ──────────────────────────────────────────────

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

  // ── Task routing (delegates to processors) ─────────────────────────

  async handleTask(task: Task): Promise<void> {
    if (this.resetting) {
      console.log(`[ContextPool] Rejecting task ${task.messageId} — pool is resetting`);
      return;
    }

    this.inflightEnter();
    try {
      if (task.type === 'main') {
        await this.mainProcessor.queueMainTask(task);
      } else {
        await this.windowProcessor.handleWindowTask(task);
      }
    } finally {
      this.inflightExit();
    }
  }

  recordMonitorAction(monitorId: string): void {
    this.mainProcessor.recordMonitorAction(monitorId);
  }

  async dispatchTask(options: {
    objective?: string;
    profile?: string;
    hint?: string;
    monitorId?: string;
    messageId?: string;
  }): Promise<DispatchResult> {
    return this.dispatcher.dispatchTask(options);
  }

  handleWindowClose(windowId: string): void {
    this.windowProcessor.handleWindowClose(windowId);
  }

  // ── Query methods ──────────────────────────────────────────────────

  getContextTape(): ContextTape {
    return this.contextTape;
  }

  getTimeline(): InteractionTimeline {
    return this.timeline;
  }

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

  // ── Reset / Cleanup ────────────────────────────────────────────────

  /**
   * Shared teardown logic used by both reset() and cleanup().
   * Clears queues, interrupts agents, waits for inflight tasks, disposes agents.
   */
  private async teardown(): Promise<void> {
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
      console.error('[ContextPool] Teardown: interruptAll failed:', err);
    }

    // 4. Wait for all in-flight task functions to return (with timeout)
    try {
      await Promise.race([
        this.awaitInflight(),
        new Promise<void>((resolve) => setTimeout(resolve, 30_000)),
      ]);
    } catch (err) {
      console.error('[ContextPool] Teardown: awaitInflight failed:', err);
    }

    // 5. Now safe to dispose agents (no in-flight references)
    try {
      await this.agentPool.cleanup();
    } catch (err) {
      console.error('[ContextPool] Teardown: agentPool.cleanup failed:', err);
    }

    // 6. Close all tracked windows on the frontend
    const openWindows = this.windowState.listWindows();
    if (openWindows.length > 0) {
      const closeActions = openWindows.map((win) => ({
        type: 'window.close' as const,
        windowId: win.id,
      }));
      await this.sendEvent({ type: ServerEventType.ACTIONS, actions: closeActions });
    }

    // 7. Clear remaining state
    this.contextTape.clear();
    this.timeline.clear();
    this.windowAgentMap.clear();
    this.windowConnectionPolicy.clear();
    this.windowState.clear();
    this.budgetPolicy.clear();
  }

  async reset(): Promise<void> {
    if (this.resetting) return;
    this.resetting = true;

    // Save active monitor IDs before clearing so we can recreate agents for all of them
    const activeMonitorIds = [...this.mainQueues.keys()];
    for (const monitorId of this.agentPool.getMainAgentMonitorIds()) {
      if (!activeMonitorIds.includes(monitorId)) {
        activeMonitorIds.push(monitorId);
      }
    }
    if (!activeMonitorIds.includes('monitor-0')) {
      activeMonitorIds.push('monitor-0');
    }

    await this.teardown();

    // Dispose pooled Codex providers (AppServer process stays alive)
    try {
      await getWarmPool().resetCodexProviders();
    } catch (err) {
      console.error('[ContextPool] Reset: resetCodexProviders failed:', err);
    }

    // Clear saved thread IDs so we don't resume old sessions
    this.savedThreadIds = undefined;

    // Re-create fresh main agents for ALL previously active monitors
    for (const monitorId of activeMonitorIds) {
      const provider = await acquireWarmProvider();
      if (provider) {
        const agent = await this.agentPool.createMainAgent(monitorId, provider);
        if (agent) {
          if (monitorId === 'monitor-0') {
            await this.sendEvent({
              type: ServerEventType.CONNECTION_STATUS,
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

  async cleanup(): Promise<void> {
    this.resetting = true;
    await this.teardown();
    this.sharedLogger = null;
    this.resetting = false;
  }
}
