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
import { windowState } from '../mcp/window-state.js';
import { reloadCache, computeFingerprint } from '../reload/index.js';
import type { CacheMatch } from '../reload/types.js';

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

  // Main task queue (sequential processing)
  private mainQueue: Array<{ task: Task; timestamp: number }> = [];
  private processingMain = false;

  // Window task tracking
  private windowAgentMap: Map<string, string> = new Map();
  private windowProcessing: Map<string, boolean> = new Map();
  private windowQueues: Map<string, Array<{ task: Task; timestamp: number }>> = new Map();

  constructor(connectionId: ConnectionId, restoredContext: ContextMessage[] = []) {
    this.connectionId = connectionId;
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
      sessionId: provider.getSessionId?.() ?? undefined,
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

    if (this.mainQueue.length >= MAX_QUEUE_SIZE) {
      await this.sendEvent({
        type: 'ERROR',
        error: `Message queue is full (${MAX_QUEUE_SIZE} messages). Please wait for current operations to complete.`,
      });
      return;
    }

    this.mainQueue.push({ task, timestamp: Date.now() });
    console.log(`[ContextPool] Queued main task ${task.messageId}, queue size: ${this.mainQueue.length}`);

    await this.sendEvent({
      type: 'MESSAGE_QUEUED',
      messageId: task.messageId,
      position: this.mainQueue.length,
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
    const interactionPrefix = task.interactions?.length
      ? formatInteractionsForContext(task.interactions)
      : '';
    this.contextTape.append('user', interactionPrefix + task.content, 'main');

    // Compute fingerprint and check for reload matches
    const windowSnapshot = windowState.listWindows();
    const fp = computeFingerprint(task, windowSnapshot);
    const matches = reloadCache.findMatches(fp, 3);
    const reloadPrefix = formatReloadOptions(matches);

    const openWindowsContext = formatOpenWindows();
    await agent.session.handleMessage(openWindowsContext + reloadPrefix + task.content, {
      role: agent.currentRole!,
      source: 'main',
      interactions: task.interactions,
      messageId: task.messageId,
      onContextMessage: (role, content) => {
        if (role === 'assistant') {
          this.contextTape.append(role, content, 'main');
        }
      },
    });

    // Record actions for future cache hits
    const recordedActions = agent.session.getRecordedActions();
    if (recordedActions.length > 0) {
      reloadCache.record(fp, recordedActions, generateCacheLabel(task));
    }

    this.agentPool.release(agent);
    await this.processMainQueue();
  }

  private async processMainQueue(): Promise<void> {
    if (this.processingMain || this.mainQueue.length === 0) return;

    this.processingMain = true;
    try {
      while (this.mainQueue.length > 0) {
        const agent = this.agentPool.findIdle();
        if (!agent) break;

        const next = this.mainQueue.shift();
        if (next) await this.processMainTask(agent, next.task);
      }
    } finally {
      this.processingMain = false;
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
    if (!isParallel && this.windowProcessing.get(processingKey)) {
      let queue = this.windowQueues.get(processingKey);
      if (!queue) {
        queue = [];
        this.windowQueues.set(processingKey, queue);
      }
      queue.push({ task, timestamp: Date.now() });
      console.log(`[ContextPool] Queued task ${task.messageId} for ${processingKey}, queue size: ${queue.length}`);

      await this.sendEvent({
        type: 'MESSAGE_QUEUED',
        messageId: task.messageId,
        position: queue.length,
      });
      return;
    }

    this.windowProcessing.set(processingKey, true);

    // Acquire global agent slot
    const limiter = getAgentLimiter();
    try {
      await limiter.acquire(30000);
    } catch (err) {
      this.windowProcessing.set(processingKey, false);
      console.error(`[ContextPool] Failed to acquire limiter for ${task.messageId}:`, err);
      await this.sendEvent({
        type: 'ERROR',
        error: `Failed to acquire agent slot: ${err instanceof Error ? err.message : String(err)}`,
      });
      if (!isParallel) await this.processWindowQueue(processingKey);
      return;
    }

    try {
      const agent = await this.agentPool.acquire(`window-${windowId}`);
      if (!agent) {
        limiter.release();
        this.windowProcessing.set(processingKey, false);
        console.error(`[ContextPool] Failed to acquire agent for window ${windowId}`);
        await this.sendEvent({
          type: 'ERROR',
          error: `Failed to acquire agent for window ${windowId}`,
        });
        if (!isParallel) await this.processWindowQueue(processingKey);
        return;
      }

      console.log(`[ContextPool] Agent ${agent.instanceId} acquired for window ${windowId}`);

      await this.sharedLogger?.registerAgent(`window-${windowId}`, 'default', windowId);
      await this.sendWindowStatus(windowId, `window-${windowId}`, 'assigned');

      await this.sendEvent({
        type: 'MESSAGE_ACCEPTED',
        messageId: task.messageId,
        agentId: `window-${windowId}`,
      });

      await this.sendWindowStatus(windowId, `window-${windowId}`, 'active');

      // Compute fingerprint and check for reload matches
      const windowSnapshot = windowState.listWindows();
      const fp = computeFingerprint(task, windowSnapshot);
      const matches = reloadCache.findMatches(fp, 3);
      const reloadPrefix = formatReloadOptions(matches);

      const contextPrefix = this.contextTape.formatForPrompt({ includeWindows: false });
      const openWindowsContext = formatOpenWindows();
      const source: ContextSource = { window: windowId };

      // Record user message immediately
      this.contextTape.append('user', task.content, source);

      await agent.session.handleMessage(openWindowsContext + reloadPrefix + contextPrefix + task.content, {
        role: `window-${windowId}`,
        source,
        interactions: task.interactions,
        messageId: task.messageId,
        onContextMessage: (role, content) => {
          if (role === 'assistant') {
            this.contextTape.append(role, content, source);
          }
        },
      });

      // Record actions for future cache hits
      const recordedActions = agent.session.getRecordedActions();
      if (recordedActions.length > 0) {
        const requiredWindowIds = windowId ? [windowId] : undefined;
        reloadCache.record(fp, recordedActions, generateCacheLabel(task), { requiredWindowIds });
      }

      this.agentPool.release(agent);
      await this.sendWindowStatus(windowId, `window-${windowId}`, 'released');
    } finally {
      limiter.release();
      this.windowProcessing.set(processingKey, false);
      if (!isParallel) await this.processWindowQueue(processingKey);
    }
  }

  private async processWindowQueue(windowId: string): Promise<void> {
    const queue = this.windowQueues.get(windowId);
    if (!queue || queue.length === 0) return;

    const next = queue.shift();
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
    await this.agentPool.interruptAll();
    this.contextTape.clear();
    this.mainQueue = [];
    this.windowQueues.clear();
    this.windowProcessing.clear();
    this.windowAgentMap.clear();
    windowState.clear();
    console.log(`[ContextPool] Reset: cleared context tape, queues, and window state`);
  }

  async interruptAgent(agentId: string): Promise<boolean> {
    return this.agentPool.interruptByRole(agentId);
  }

  hasActiveAgent(windowId: string): boolean {
    return this.agentPool.hasRole(`window-${windowId}`);
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
    const windowQueueSizes: Record<string, number> = {};
    for (const [windowId, queue] of this.windowQueues) {
      if (queue.length > 0) {
        windowQueueSizes[windowId] = queue.length;
      }
    }
    return {
      ...poolStats,
      mainQueueSize: this.mainQueue.length,
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
    this.mainQueue = [];
    this.windowAgentMap.clear();
    this.windowProcessing.clear();
    this.windowQueues.clear();
    this.contextTape.clear();
    this.sharedLogger = null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Format user interactions into a context string.
 * Drawings are noted but not embedded (sent as native images to provider).
 */
function formatInteractionsForContext(interactions: UserInteraction[]): string {
  if (interactions.length === 0) return '';

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

  return parts.length > 0 ? parts.join('\n\n') + '\n\n' : '';
}

/**
 * Format open windows as minimal context for AI.
 * Returns empty string if no windows are open.
 */
function formatOpenWindows(): string {
  const windows = windowState.listWindows();
  if (windows.length === 0) return '';

  const ids = windows.map(w => w.id).join(', ');
  return `<open_windows>${ids}</open_windows>\n\n`;
}

/**
 * Format reload cache matches as context for AI.
 * Returns empty string if no matches.
 */
function formatReloadOptions(matches: CacheMatch[]): string {
  if (matches.length === 0) return '';

  const options = matches.map(m => ({
    cacheId: m.entry.id,
    label: m.entry.label,
    similarity: parseFloat(m.similarity.toFixed(2)),
    actions: m.entry.actions.length,
    exact: m.isExact,
  }));

  return `<reload_options>\n${JSON.stringify(options)}\n</reload_options>\n\n`;
}

/**
 * Generate a human-readable label for a cache entry from task content.
 */
function generateCacheLabel(task: Task): string {
  const content = task.content.trim();

  // Try to extract app name from click interaction pattern
  const appMatch = content.match(/app:\s*(\w+)/i);
  if (appMatch) {
    return `Open ${appMatch[1]} app`;
  }

  // Try to extract button click pattern
  const buttonMatch = content.match(/button\s+"([^"]+)"/i);
  if (buttonMatch) {
    return `Click "${buttonMatch[1]}"`;
  }

  // Truncate content as label
  const maxLen = 50;
  if (content.length <= maxLen) return content;
  return content.slice(0, maxLen).trimEnd() + '...';
}
