/**
 * ContextPool - Unified task orchestration facade.
 *
 * Routes tasks to agents via AgentPool:
 * - Monitor tasks: monitor agent (idle) or ephemeral agent (busy) — sequential queue
 * - App tasks: persistent per-app agents for app protocol windows
 * - Plain window tasks: routed to the main agent with full conversation context
 * - InteractionTimeline: user interactions and agent actions accumulated, drained on monitor agent's next turn
 * - ContextTape: kept for logging/debugging
 *
 * Processing logic is delegated to:
 * - MonitorTaskProcessor: main queue, ephemeral overflow, budget enforcement
 * - AppTaskProcessor: app agent lifecycle and task execution
 * Complex work is delegated to native provider subagents (Claude Task / Codex collab)
 */

import { ContextTape, type ContextMessage } from './context.js';
import { AgentPool, type PooledAgent } from './agent-pool.js';
import type { AgentSession } from './agent-session.js';
import { InteractionTimeline } from './interaction-timeline.js';
import { ServerEventType, type ServerEvent, type UserInteraction } from '@yaar/shared';
import type { ProviderType } from '../providers/types.js';
import { createSession, SessionLogger } from '../logging/index.js';
import type { SessionId } from '../session/types.js';
import { getAgentLimiter } from './limiter.js';
import { acquireWarmProvider, getWarmPool } from '../providers/factory.js';
import type { WindowStateRegistry } from '../session/window-state.js';
import type { ReloadCache } from '../reload/cache.js';
import {
  MonitorQueuePolicy,
  WindowQueuePolicy,
  ContextAssemblyPolicy,
  ReloadCachePolicy,
  MonitorBudgetPolicy,
  WindowSubscriptionPolicy,
} from './context-pool-policies/index.js';
import type { WindowChangeEvent } from './context-pool-policies/index.js';
import { MonitorTaskProcessor } from './monitor-task-processor.js';
import { AppTaskProcessor } from './app-task-processor.js';
import type { PoolContext, Task } from './pool-types.js';

// Re-export Task for barrel compatibility
export type { Task } from './pool-types.js';

const MAX_QUEUE_SIZE = 10;

/**
 * ContextPool manages task orchestration with a persistent monitor agent,
 * ephemeral overflow agents, and persistent per-window agents.
 *
 * Implements PoolContext so processors can access shared state and policies.
 */
export class ContextPool implements PoolContext {
  private logSessionId: string | null = null;

  // ── PoolContext fields (readonly for processors) ───────────────────
  readonly agentPool: AgentPool;
  readonly contextTape: ContextTape;
  readonly timeline: InteractionTimeline;
  readonly windowState: WindowStateRegistry;
  readonly contextAssembly = new ContextAssemblyPolicy();
  readonly reloadPolicy: ReloadCachePolicy;
  readonly windowQueuePolicy = new WindowQueuePolicy();
  readonly budgetPolicy = new MonitorBudgetPolicy();
  readonly windowSubscriptionPolicy = new WindowSubscriptionPolicy();
  sharedLogger: SessionLogger | null = null;
  savedThreadIds?: Record<string, string>;
  providerType: ProviderType | null = null;

  // ── Internal state ────────────────────────────────────────────────
  private broadcastFn: (event: ServerEvent) => void;
  private monitorQueues = new Map<string, MonitorQueuePolicy>();
  private resetting = false;
  private inflightCount = 0;
  private inflightResolve: (() => void) | null = null;

  // ── Processors ────────────────────────────────────────────────────
  private monitorProcessor: MonitorTaskProcessor;
  private appProcessor: AppTaskProcessor;

  constructor(
    sessionId: SessionId,
    windowState: WindowStateRegistry,
    reloadCache: ReloadCache,
    broadcast: (event: ServerEvent) => void,
    restoredContext: ContextMessage[] = [],
    savedThreadIds?: Record<string, string>,
  ) {
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
    this.agentPool = new AgentPool(sessionId, broadcast, (rawId, monitorId) => {
      // Resolve raw window ID to scoped handle via the handle map.
      // If monitorId is provided, register/resolve; otherwise try lookup.
      if (monitorId) {
        const existing = windowState.handleMap.resolve(rawId);
        return existing ?? windowState.handleMap.register(rawId, monitorId);
      }
      return windowState.handleMap.resolve(rawId) ?? rawId;
    });

    // Create processors
    this.monitorProcessor = new MonitorTaskProcessor(this);
    this.appProcessor = new AppTaskProcessor(this);
  }

  // ── PoolContext methods ─────────────────────────────────────────────

  getOrCreateMonitorQueue(monitorId: string): MonitorQueuePolicy {
    let queue = this.monitorQueues.get(monitorId);
    if (!queue) {
      queue = new MonitorQueuePolicy(MAX_QUEUE_SIZE);
      this.monitorQueues.set(monitorId, queue);
    }
    return queue;
  }

  async sendEvent(event: ServerEvent): Promise<void> {
    this.broadcastFn(event);
  }

  notifyHookResponse(
    appId: string,
    windowId: string,
    monitorId: string,
    responseText: string,
  ): void {
    const messageId = `hook-resp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.handleTask({
      type: 'monitor',
      messageId,
      monitorId,
      content: `<agent-hook type="response" appId="${appId}" windowId="${windowId}">${responseText || '(no response text)'}</agent-hook>`,
    }).catch((err) => {
      console.error('[ContextPool] Hook response delivery failed:', err);
    });
  }

  // ── Initialization ─────────────────────────────────────────────────

  async initialize(existingLogger?: SessionLogger): Promise<boolean> {
    const provider = await acquireWarmProvider();
    if (!provider) {
      await this.sendEvent({
        type: ServerEventType.ERROR,
        error: 'No AI provider available. Install Claude CLI.',
      });
      return false;
    }

    this.providerType = provider.providerType;
    if (existingLogger) {
      // Reuse the session-owned logger (already has a log directory)
      this.sharedLogger = existingLogger;
      this.logSessionId = existingLogger.getSessionId();
      // Update provider name now that we know it
      existingLogger.updateProvider(provider.name);
    } else {
      const sessionInfo = await createSession(provider.name);
      this.sharedLogger = new SessionLogger(sessionInfo);
      this.logSessionId = sessionInfo.sessionId;
    }
    this.agentPool.setLogger(this.sharedLogger);

    const monitorAgent = await this.agentPool.createMonitorAgent('0', provider);
    if (!monitorAgent) {
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

    const agent = await this.agentPool.createMonitorAgent(monitorId, provider);
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

  hasMonitorAgent(monitorId: string): boolean {
    return this.agentPool.hasMonitorAgent(monitorId);
  }

  getMonitorAgentCount(): number {
    return this.agentPool.getMonitorAgentCount();
  }

  getMonitorAgentIds(): string[] {
    return this.agentPool.getMonitorAgentIds();
  }

  getLogSessionId(): string | null {
    return this.logSessionId;
  }

  async removeMonitorAgent(monitorId: string): Promise<void> {
    const queue = this.monitorQueues.get(monitorId);
    if (queue) {
      queue.clear();
      this.monitorQueues.delete(monitorId);
    }

    const removed = await this.agentPool.removeMonitorAgent(monitorId);
    if (removed) {
      console.log(`[ContextPool] Removed monitor agent for ${monitorId}`);
    }
  }

  // ── Monitor suspend/resume ──────────────────────────────────────────

  suspendMonitor(monitorId: string): boolean {
    if (!this.agentPool.hasMonitorAgent(monitorId)) return false;
    const queue = this.getOrCreateMonitorQueue(monitorId);
    queue.suspend();
    console.log(`[ContextPool] Suspended monitor ${monitorId}`);
    return true;
  }

  resumeMonitor(monitorId: string): boolean {
    const queue = this.monitorQueues.get(monitorId);
    if (!queue || !queue.isSuspended()) return false;
    queue.resume();
    console.log(`[ContextPool] Resumed monitor ${monitorId}`);
    // Drain any pending tasks
    this.monitorProcessor
      .processMonitorQueue(monitorId)
      .catch((err) => console.error(`[ContextPool] Error draining queue after resume:`, err));
    return true;
  }

  isMonitorSuspended(monitorId: string): boolean {
    const queue = this.monitorQueues.get(monitorId);
    return queue?.isSuspended() ?? false;
  }

  // ── Session agent ─────────────────────────────────────────────────

  async getOrCreateSessionAgent(): Promise<PooledAgent | null> {
    const existing = this.agentPool.getSessionAgent();
    if (existing) return existing;
    return this.agentPool.createSessionAgent();
  }

  async disposeSessionAgent(): Promise<void> {
    await this.agentPool.disposeSessionAgent();
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
      if (task.type === 'monitor') {
        await this.monitorProcessor.queueMonitorTask(task);
      } else {
        // Check if this window belongs to an app (appId set on window.create)
        const appId = task.windowId ? this.windowState.getAppIdForWindow(task.windowId) : undefined;
        if (appId && task.windowId) {
          await this.appProcessor.handleAppTask(task, appId);
        } else {
          // Plain window → route to monitor agent with full conversation context
          await this.monitorProcessor.queueMonitorTask({ ...task, type: 'monitor' });
        }
      }
    } finally {
      this.inflightExit();
    }
  }

  /**
   * Find the windowId for a given agent instanceId.
   * Checks app agents via AppTaskProcessor.
   */
  findWindowForAgent(agentId: string): string | undefined {
    // App agent -> look up active window via AppTaskProcessor
    const appId = this.agentPool.findAppIdForAgent(agentId);
    if (appId) return this.appProcessor.getActiveWindowId(appId);

    return undefined;
  }

  recordMonitorAction(monitorId: string): void {
    this.monitorProcessor.recordMonitorAction(monitorId);
  }

  notifyWindowSubscribers(
    windowId: string,
    event: WindowChangeEvent,
    summary: string,
    sourceAgentKey?: string,
  ): void {
    this.windowSubscriptionPolicy.notifyChange(windowId, event, summary, sourceAgentKey, (task) => {
      this.handleTask(task).catch((err) => {
        console.error('[ContextPool] Error delivering subscription notification:', err);
      });
    });
  }

  handleWindowClose(windowId: string, appId?: string): void {
    // Clean up subscriptions and prune context for this window
    this.windowSubscriptionPolicy.clearForWindow(windowId);
    this.contextTape.pruneWindow(windowId);

    // If this window belongs to an app, interrupt the running agent and clear its queue
    if (appId) {
      this.appProcessor.handleWindowClose(windowId, appId).catch((err) => {
        console.error(`[ContextPool] Error interrupting app agent on window close:`, err);
      });
    }
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

  getPrimaryAgent(monitorId?: string): AgentSession | null {
    return this.agentPool.getMonitorAgentSession(monitorId);
  }

  async interruptAll(): Promise<void> {
    await this.agentPool.interruptAll();
  }

  async interruptAgent(agentId: string): Promise<boolean> {
    return this.agentPool.interruptByRole(agentId);
  }

  hasAgent(agentId: string): boolean {
    return this.agentPool.hasAgent(agentId);
  }

  hasActiveAgent(windowId: string): boolean {
    // Check app agents via appId lookup
    const appId = this.windowState.getAppIdForWindow(windowId);
    if (appId) {
      return this.agentPool.hasRolePrefix(`app-${appId}`);
    }
    // Plain windows are handled by the monitor agent, so check for monitor agent activity
    return false;
  }

  getStats(): {
    totalAgents: number;
    idleAgents: number;
    busyAgents: number;
    monitorQueueSize: number;
    windowQueueSizes: Record<string, number>;
    contextTapeSize: number;
    timelineSize: number;
    monitorAgent: boolean;
    appAgents: number;
    ephemeralAgents: number;
    sessionAgent: boolean;
    monitorBudget: ReturnType<MonitorBudgetPolicy['getStats']>;
  } {
    const poolStats = this.agentPool.getStats();
    const windowQueueSizes = this.windowQueuePolicy.getQueueSizes();
    return {
      ...poolStats,
      monitorQueueSize: Array.from(this.monitorQueues.values()).reduce(
        (sum, q) => sum + q.size(),
        0,
      ),
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
  private async teardown(options?: { closeWindows?: boolean }): Promise<void> {
    const closeWindows = options?.closeWindows ?? true;
    // 1. Clear queues so no new tasks start from dequeue
    this.monitorQueues.forEach((q) => q.clear());
    this.monitorQueues.clear();
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

    // 6. Close all tracked windows on the frontend (skip during reset — frontend preserves windows)
    if (closeWindows) {
      const openWindows = this.windowState.listWindows();
      if (openWindows.length > 0) {
        const closeActions = openWindows.map((win) => ({
          type: 'window.close' as const,
          windowId: win.id,
        }));
        await this.sendEvent({ type: ServerEventType.ACTIONS, actions: closeActions });
      }
    }

    // 7. Clear remaining state
    this.contextTape.clear();
    this.timeline.clear();
    this.windowSubscriptionPolicy.clear();
    this.appProcessor.disposeAll();
    if (closeWindows) {
      this.windowState.clear();
    }
    this.budgetPolicy.clear();
  }

  async reset(): Promise<void> {
    if (this.resetting) return;
    this.resetting = true;

    // Save active monitor IDs before clearing so we can recreate agents for all of them
    const activeMonitorIds = [...this.monitorQueues.keys()];
    for (const monitorId of this.agentPool.getMonitorAgentIds()) {
      if (!activeMonitorIds.includes(monitorId)) {
        activeMonitorIds.push(monitorId);
      }
    }
    if (!activeMonitorIds.includes('0')) {
      activeMonitorIds.push('0');
    }

    await this.teardown({ closeWindows: false });

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
        const agent = await this.agentPool.createMonitorAgent(monitorId, provider);
        if (agent) {
          if (monitorId === '0') {
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
