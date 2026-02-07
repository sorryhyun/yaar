/**
 * ContextPool - Unified task orchestration with context-centric architecture.
 *
 * Routes tasks to agents via AgentPool:
 * - Main tasks are processed sequentially
 * - Window tasks run in parallel across windows, sequentially within each
 * - ContextTape records all conversation history by source
 */

import { AgentSession } from './session.js';
import { ContextTape, type ContextMessage, type ContextSource } from './context.js';
import { AgentPool, type PooledAgent } from './agent-pool.js';
import type { ServerEvent, UserInteraction } from '@yaar/shared';
import { createSession, SessionLogger } from '../logging/index.js';
import { getBroadcastCenter, type ConnectionId } from '../events/broadcast-center.js';
import { getAgentLimiter } from './limiter.js';
import { acquireWarmProvider } from '../providers/factory.js';
import type { WindowStateRegistry } from '../mcp/window-state.js';
import type { ReloadCache } from '../reload/cache.js';
import { MainQueuePolicy } from './context-pool-policies/main-queue-policy.js';
import { WindowQueuePolicy } from './context-pool-policies/window-queue-policy.js';
import { ContextAssemblyPolicy } from './context-pool-policies/context-assembly-policy.js';
import { ReloadCachePolicy } from './context-pool-policies/reload-cache-policy.js';

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
 * ContextPool manages task orchestration with a shared context tape.
 */
export class ContextPool {
  private connectionId: ConnectionId;
  private agentPool: AgentPool;
  private contextTape: ContextTape;
  private sharedLogger: SessionLogger | null = null;
  private windowState: WindowStateRegistry;

  // Window task tracking
  private windowAgentMap: Map<string, string> = new Map();
  private mainQueuePolicy = new MainQueuePolicy(MAX_QUEUE_SIZE);
  private windowQueuePolicy = new WindowQueuePolicy();
  private contextAssembly = new ContextAssemblyPolicy();
  private reloadPolicy: ReloadCachePolicy;
  private logSessionId: string | null = null;
  private savedThreadIds?: Record<string, string>;

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
    if (restoredContext.length > 0) {
      this.contextTape.restore(restoredContext);
      console.log(`[ContextPool] Restored ${restoredContext.length} context messages from previous session`);
    }
    this.agentPool = new AgentPool(connectionId);
  }

  /**
   * Initialize the pool with the first agent.
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

    const firstAgent = await this.agentPool.createAgent(provider);
    if (!firstAgent) {
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

  // ── Task routing ──────────────────────────────────────────────────────

  /**
   * Single entry point for all tasks.
   */
  async handleTask(task: Task): Promise<void> {
    if (task.type === 'main') {
      await this.queueMainTask(task);
    } else {
      await this.handleWindowTask(task);
    }
  }

  // ── Main task processing ──────────────────────────────────────────────

  private async queueMainTask(task: Task): Promise<void> {
    const agent = this.agentPool.findIdle();
    if (agent) {
      await this.processMainTask(agent, task);
      return;
    }

    const newAgent = await this.agentPool.createAgent();
    if (newAgent) {
      await this.processMainTask(newAgent, task);
      return;
    }

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

  private async processMainTask(agent: PooledAgent, task: Task): Promise<void> {
    this.agentPool.clearIdleTimer(agent);
    agent.currentRole = `main-${task.messageId}`;
    agent.lastUsed = Date.now();

    await this.sendEvent({
      type: 'MESSAGE_ACCEPTED',
      messageId: task.messageId,
      agentId: `main-${task.messageId}`,
    });

    console.log(`[ContextPool] Processing main task ${task.messageId} with agent ${agent.id}`);

    // Record user message immediately so parallel tasks can see it
    const windowSnapshot = this.windowState.listWindows();
    const openWindowsContext = this.contextAssembly.formatOpenWindows(windowSnapshot.map(w => w.id));
    const fp = this.reloadPolicy.buildFingerprint(task, windowSnapshot);
    const reloadPrefix = this.reloadPolicy.formatReloadOptions(this.reloadPolicy.findMatches(fp, 3));
    const mainContext = this.contextAssembly.buildMainPrompt(task.content, {
      interactions: task.interactions,
      openWindows: openWindowsContext,
      reloadPrefix,
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

    this.agentPool.release(agent);
    await this.processMainQueue();
  }

  private async processMainQueue(): Promise<void> {
    if (!this.mainQueuePolicy.beginProcessing()) return;
    try {
      while (this.mainQueuePolicy.size() > 0) {
        const agent = this.agentPool.findIdle();
        if (!agent) break;

        const next = this.mainQueuePolicy.dequeue();
        if (next) await this.processMainTask(agent, next.task);
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
    const processingKey = task.actionId ?? windowId;
    const isParallel = !!task.actionId;
    console.log(`[ContextPool] handleWindowTask: ${task.messageId} for ${windowId} (key: ${processingKey}, parallel: ${isParallel})`);

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

    // Acquire global agent slot
    const limiter = getAgentLimiter();
    try {
      await limiter.acquire(30000);
    } catch (err) {
      this.windowQueuePolicy.setProcessing(processingKey, false);
      console.error(`[ContextPool] Failed to acquire limiter for ${task.messageId}:`, err);
      await this.sendEvent({
        type: 'ERROR',
        error: `Failed to acquire agent slot: ${err instanceof Error ? err.message : String(err)}`,
      });
      if (!isParallel) await this.processWindowQueue(processingKey);
      return;
    }

    // Use unique agent IDs for parallel tasks so the dashboard shows each one
    const agentRole = isParallel
      ? `window-${windowId}/${task.actionId}`
      : `window-${windowId}`;

    try {
      const agent = await this.agentPool.acquire(agentRole);
      if (!agent) {
        limiter.release();
        this.windowQueuePolicy.setProcessing(processingKey, false);
        console.error(`[ContextPool] Failed to acquire agent for window ${windowId}`);
        await this.sendEvent({
          type: 'ERROR',
          error: `Failed to acquire agent for window ${windowId}`,
        });
        if (!isParallel) await this.processWindowQueue(processingKey);
        return;
      }

      console.log(`[ContextPool] Agent ${agent.instanceId} acquired for window ${windowId} (role: ${agentRole})`);

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

      const contextPrefix = this.contextTape.formatForPrompt({ includeWindows: false });
      const openWindowsContext = this.contextAssembly.formatOpenWindows(windowSnapshot.map(w => w.id));
      const source: ContextSource = { window: windowId };

      // Record user message immediately
      this.contextAssembly.appendUserMessage(this.contextTape, task.content, source);

      // Get parent session ID for thread forking (inherits main conversation context)
      const parentSessionId = this.agentPool.getPrimaryAgent()?.getRawSessionId() ?? undefined;

      const canonicalWindow = `window-${windowId}`;
      const resumeSessionId = this.savedThreadIds?.[canonicalWindow];
      delete this.savedThreadIds?.[canonicalWindow];

      await agent.session.handleMessage(this.contextAssembly.buildWindowPrompt(task.content, {
        openWindows: openWindowsContext,
        reloadPrefix,
        contextPrefix,
      }), {
        role: agentRole,
        source,
        interactions: task.interactions,
        messageId: task.messageId,
        forkSession: !resumeSessionId, // Skip fork if resuming a saved thread
        parentSessionId: resumeSessionId ? undefined : parentSessionId,
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

      this.agentPool.release(agent);
      await this.sendWindowStatus(windowId, agentRole, 'released');
    } finally {
      limiter.release();
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

  // ── Query methods ─────────────────────────────────────────────────────

  getContextTape(): ContextTape {
    return this.contextTape;
  }

  pruneWindowContext(windowId: string): void {
    const pruned = this.contextTape.pruneWindow(windowId);
    console.log(`[ContextPool] Pruned ${pruned.length} messages from window ${windowId}`);
  }

  getSessionLogger(): SessionLogger | null {
    return this.sharedLogger;
  }

  getPrimaryAgent(): AgentSession | null {
    return this.agentPool.getPrimaryAgent();
  }

  async interruptAll(): Promise<void> {
    await this.agentPool.interruptAll();
  }

  async reset(): Promise<void> {
    // Dispose all agents (and their providers) — not just interrupt
    await this.agentPool.cleanup();
    this.contextTape.clear();
    this.mainQueuePolicy.clear();
    this.windowQueuePolicy.clear();
    this.windowAgentMap.clear();
    this.windowState.clear();

    // Re-create a fresh primary agent so the pool is ready for the next message
    const provider = await acquireWarmProvider();
    if (provider) {
      const agent = await this.agentPool.createAgent(provider);
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

    console.log(`[ContextPool] Reset: disposed agents, cleared context tape, queues, and window state`);
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
  } {
    const poolStats = this.agentPool.getStats();
    const windowQueueSizes = this.windowQueuePolicy.getQueueSizes();
    return {
      ...poolStats,
      mainQueueSize: this.mainQueuePolicy.size(),
      windowQueueSizes,
      contextTapeSize: this.contextTape.length,
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
    await this.agentPool.cleanup();
    this.mainQueuePolicy.clear();
    this.windowAgentMap.clear();
    this.windowQueuePolicy.clear();
    this.contextTape.clear();
    this.sharedLogger = null;
  }
}
