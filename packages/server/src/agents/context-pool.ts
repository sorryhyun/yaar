/**
 * ContextPool - Unified agent pool with context-centric architecture.
 *
 * Merges DefaultAgentPool and WindowAgentPool into a single pool where:
 * - Agents are dynamically assigned roles based on task type
 * - Context (ContextTape) is the central organizing principle
 * - Main tasks are processed sequentially, window tasks in parallel
 * - Agent identities ('default', 'window-{id}') are preserved
 */

import { AgentSession } from './session.js';
import { ContextTape, type ContextSource } from './context.js';
import type { ServerEvent, UserInteraction } from '@yaar/shared';
import { createSession, SessionLogger } from '../logging/index.js';
import { getBroadcastCenter, type ConnectionId } from '../events/broadcast-center.js';
import { getAgentLimiter } from './limiter.js';
import { acquireWarmProvider } from '../providers/factory.js';
import type { AITransport } from '../providers/types.js';

/**
 * Pool configuration constants.
 */
const POOL_CONFIG = {
  maxAgents: 5,
  maxQueueSize: 10,
  idleTimeoutMs: 180000, // 3 minutes
};

/**
 * A task to be processed by the pool.
 */
export interface Task {
  type: 'main' | 'window';
  messageId: string;
  windowId?: string; // Required for window tasks
  content: string;
  interactions?: UserInteraction[];
  actionId?: string; // For parallel button actions - use as processing key instead of windowId
}

/**
 * Internal pooled agent representation.
 */
interface PooledAgent {
  session: AgentSession;
  id: number;
  instanceId: string; // Unique ID for this agent instance
  lastUsed: number;
  currentRole: string | null; // 'default' or 'window-{id}' when active
  idleTimer: NodeJS.Timeout | null;
}

/**
 * Queued main task for sequential processing.
 */
interface QueuedMainTask {
  task: Task;
  timestamp: number;
}

/**
 * Queued window task for per-window sequential processing.
 */
interface QueuedWindowTask {
  task: Task;
  timestamp: number;
}

/**
 * ContextPool manages a unified pool of agents with dynamic role assignment.
 */
export class ContextPool {
  private connectionId: ConnectionId;
  private agents: PooledAgent[] = [];
  private contextTape: ContextTape;
  private sharedLogger: SessionLogger | null = null;
  private nextAgentId = 0;

  // Main task queue (sequential processing)
  private mainQueue: QueuedMainTask[] = [];
  private processingMain = false;

  // Window task tracking and queuing
  private windowAgentMap: Map<string, string> = new Map(); // windowId -> agentId
  private windowProcessing: Map<string, boolean> = new Map(); // windowId -> isProcessing
  private windowQueues: Map<string, QueuedWindowTask[]> = new Map(); // windowId -> queued tasks

  constructor(connectionId: ConnectionId) {
    this.connectionId = connectionId;
    this.contextTape = new ContextTape();
  }

  /**
   * Initialize the pool with the first agent.
   * Uses warm pool for faster initialization.
   */
  async initialize(): Promise<boolean> {
    // Acquire a pre-warmed provider
    const provider = await acquireWarmProvider();
    if (!provider) {
      await this.sendEvent({
        type: 'ERROR',
        error: 'No AI provider available. Install Claude CLI.',
      });
      return false;
    }

    // Create session logger
    const sessionInfo = await createSession(provider.name);
    this.sharedLogger = new SessionLogger(sessionInfo);

    // Create the first agent with the pre-warmed provider
    const firstAgent = await this.createAgent(provider);
    if (!firstAgent) {
      // Provider not used, dispose it
      await provider.dispose();
      return false;
    }

    // Send connection status with session info
    // Note: The initial CONNECTION_STATUS was already sent on WebSocket connect
    // This update provides the sessionId after pool initialization
    await this.sendEvent({
      type: 'CONNECTION_STATUS',
      status: 'connected',
      provider: provider.name,
      sessionId: provider.getSessionId?.() ?? undefined,
    });

    return true;
  }

  /**
   * Single entry point for all tasks.
   * Routes to appropriate handler based on task type.
   */
  async handleTask(task: Task): Promise<void> {
    if (task.type === 'main') {
      await this.queueMainTask(task);
    } else {
      await this.handleWindowTask(task);
    }
  }

  /**
   * Queue a main task for sequential processing.
   */
  private async queueMainTask(task: Task): Promise<void> {
    // Try to find an idle agent
    const agent = this.findIdleAgent();

    if (agent) {
      // Process immediately
      await this.processMainTask(agent, task);
      return;
    }

    // No idle agents - try to spawn a new one
    if (this.agents.length < POOL_CONFIG.maxAgents) {
      const newAgent = await this.createAgent();
      if (newAgent) {
        await this.processMainTask(newAgent, task);
        return;
      }
    }

    // Pool full - queue the message
    if (this.mainQueue.length >= POOL_CONFIG.maxQueueSize) {
      await this.sendEvent({
        type: 'ERROR',
        error: `Message queue is full (${POOL_CONFIG.maxQueueSize} messages). Please wait for current operations to complete.`,
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

  /**
   * Process a main task with the given agent.
   */
  private async processMainTask(agent: PooledAgent, task: Task): Promise<void> {
    // Clear idle timer
    if (agent.idleTimer) {
      clearTimeout(agent.idleTimer);
      agent.idleTimer = null;
    }

    // Assign role
    agent.currentRole = 'default';
    agent.lastUsed = Date.now();

    // Notify frontend
    await this.sendEvent({
      type: 'MESSAGE_ACCEPTED',
      messageId: task.messageId,
      agentId: 'default',
    });

    console.log(`[ContextPool] Processing main task ${task.messageId} with agent ${agent.id}`);

    // Record user message to context tape IMMEDIATELY so parallel tasks can see it
    // Format the full content with interactions prefix (same as session.ts does)
    const interactionPrefix = task.interactions && task.interactions.length > 0
      ? this.formatInteractionsForContext(task.interactions)
      : '';
    const fullUserContent = interactionPrefix + task.content;
    this.contextTape.append('user', fullUserContent, 'main');

    // Process the message with role and context recording
    // Only record assistant response in callback (user already recorded above)
    await agent.session.handleMessage(task.content, {
      role: 'default',
      source: 'main',
      interactions: task.interactions,
      messageId: task.messageId,
      onContextMessage: (role, content) => {
        // Only record assistant messages - user message already recorded above
        if (role === 'assistant') {
          this.contextTape.append(role, content, 'main');
        }
      },
    });

    // Clear role and start idle timer
    agent.currentRole = null;
    this.startIdleTimer(agent);

    // Process queued main tasks
    await this.processMainQueue();
  }

  /**
   * Process queued main tasks when agents become available.
   */
  private async processMainQueue(): Promise<void> {
    if (this.processingMain || this.mainQueue.length === 0) {
      return;
    }

    this.processingMain = true;
    try {
      while (this.mainQueue.length > 0) {
        const agent = this.findIdleAgent();
        if (!agent) {
          break;
        }

        const next = this.mainQueue.shift();
        if (next) {
          await this.processMainTask(agent, next.task);
        }
      }
    } finally {
      this.processingMain = false;
    }
  }

  /**
   * Handle a window task (parallel across windows, sequential within a window).
   * When actionId is provided (parallel buttons), each action runs independently.
   */
  private async handleWindowTask(task: Task): Promise<void> {
    if (!task.windowId) {
      console.error('[ContextPool] Window task missing windowId');
      return;
    }

    const windowId = task.windowId;
    // Use actionId as processing key for parallel actions, otherwise use windowId
    const processingKey = task.actionId ?? windowId;
    const isParallel = !!task.actionId;
    console.log(`[ContextPool] handleWindowTask: ${task.messageId} for ${windowId} (key: ${processingKey}, parallel: ${isParallel})`);

    // Check if this processing key is already busy (only queue if not a parallel action)
    if (!isParallel && this.windowProcessing.get(processingKey)) {
      // Queue the task for later processing
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

    // Mark processing key as busy
    this.windowProcessing.set(processingKey, true);

    // Acquire global agent slot
    const limiter = getAgentLimiter();
    try {
      await limiter.acquire(30000); // 30 second timeout
    } catch (err) {
      this.windowProcessing.set(processingKey, false);
      console.error(`[ContextPool] Failed to acquire limiter for ${task.messageId}:`, err);
      await this.sendEvent({
        type: 'ERROR',
        error: `Failed to acquire agent slot: ${err instanceof Error ? err.message : String(err)}`,
      });
      // Process any queued tasks (only for non-parallel actions)
      if (!isParallel) await this.processWindowQueue(processingKey);
      return;
    }

    try {
      // Acquire any available agent
      const agent = await this.acquireAgent(`window-${windowId}`);
      if (!agent) {
        limiter.release();
        this.windowProcessing.set(processingKey, false);
        console.error(`[ContextPool] Failed to acquire agent for window ${windowId}`);
        await this.sendEvent({
          type: 'ERROR',
          error: `Failed to acquire agent for window ${windowId}`,
        });
        // Process any queued tasks (only for non-parallel actions)
        if (!isParallel) await this.processWindowQueue(processingKey);
        return;
      }

      console.log(`[ContextPool] Agent ${agent.instanceId} acquired for window ${windowId}`);

      // Notify frontend
      await this.sendEvent({
        type: 'MESSAGE_ACCEPTED',
        messageId: task.messageId,
        agentId: `window-${windowId}`,
      });

      // Update window status
      await this.sendWindowStatus(windowId, `window-${windowId}`, 'active');

      // Format context for injection (main conversation only)
      const contextPrefix = this.contextTape.formatForPrompt({ includeWindows: false });
      const fullContent = contextPrefix + task.content;

      // Create context source for this window
      const source: ContextSource = { window: windowId };

      // Record user message to context tape IMMEDIATELY so parallel tasks can see it
      // For window tasks, the content already includes the task.content (which may have interaction formatting from manager.ts)
      this.contextTape.append('user', task.content, source);

      // Process the message
      // Only record assistant response in callback (user already recorded above)
      await agent.session.handleMessage(fullContent, {
        role: `window-${windowId}`,
        source,
        interactions: task.interactions,
        messageId: task.messageId,
        onContextMessage: (role, content) => {
          // Only record assistant messages - user message already recorded above
          if (role === 'assistant') {
            this.contextTape.append(role, content, source);
          }
        },
      });

      // Mark agent as available
      agent.currentRole = null;
      this.startIdleTimer(agent);

      // Send idle status
      await this.sendWindowStatus(windowId, `window-${windowId}`, 'idle');
    } finally {
      limiter.release();
      this.windowProcessing.set(processingKey, false);

      // Process any queued tasks (only for non-parallel actions)
      if (!isParallel) await this.processWindowQueue(processingKey);
    }
  }

  /**
   * Process queued tasks for a specific window.
   */
  private async processWindowQueue(windowId: string): Promise<void> {
    const queue = this.windowQueues.get(windowId);
    if (!queue || queue.length === 0) {
      return;
    }

    // Take the next task from the queue
    const next = queue.shift();
    if (next) {
      console.log(`[ContextPool] Processing queued task ${next.task.messageId} for window ${windowId}`);
      // Process it (will recursively process more if needed)
      await this.handleWindowTask(next.task);
    }
  }

  /**
   * Acquire an agent from the pool, assigning the given role.
   */
  private async acquireAgent(role: string): Promise<PooledAgent | null> {
    // Try to find an idle agent
    for (const agent of this.agents) {
      if (!agent.session.isRunning() && agent.currentRole === null) {
        // Clear idle timer
        if (agent.idleTimer) {
          clearTimeout(agent.idleTimer);
          agent.idleTimer = null;
        }

        agent.currentRole = role;
        agent.lastUsed = Date.now();
        return agent;
      }
    }

    // No idle agent - try to create a new one
    if (this.agents.length < POOL_CONFIG.maxAgents) {
      const agent = await this.createAgent();
      if (agent) {
        agent.currentRole = role;
        return agent;
      }
    }

    return null;
  }

  /**
   * Create a new agent in the pool.
   * @param preWarmedProvider - Optional pre-warmed provider to use for the first agent
   */
  private async createAgent(preWarmedProvider?: AITransport): Promise<PooledAgent | null> {
    // Acquire global agent slot
    const limiter = getAgentLimiter();
    if (!limiter.tryAcquire()) {
      console.log('[ContextPool] Global agent limit reached');
      return null;
    }

    const id = this.nextAgentId++;
    const instanceId = `agent-${id}-${Date.now()}`;

    const session = new AgentSession(
      this.connectionId,
      undefined, // sessionId - let SDK assign
      this.sharedLogger ?? undefined,
      instanceId
    );

    // Pass pre-warmed provider if available
    const initialized = await session.initialize(preWarmedProvider);
    if (!initialized) {
      limiter.release();
      return null;
    }

    const agent: PooledAgent = {
      session,
      id,
      instanceId,
      lastUsed: Date.now(),
      currentRole: null,
      idleTimer: null,
    };

    this.agents.push(agent);
    console.log(`[ContextPool] Created agent ${id} (${instanceId}), pool size: ${this.agents.length}`);

    return agent;
  }

  /**
   * Find an idle agent from the pool.
   */
  private findIdleAgent(): PooledAgent | null {
    for (const agent of this.agents) {
      if (!agent.session.isRunning() && agent.currentRole === null) {
        return agent;
      }
    }
    return null;
  }

  /**
   * Start idle timer for agent cleanup.
   */
  private startIdleTimer(agent: PooledAgent): void {
    // Keep at least one agent in the pool
    if (agent.id === 0 || this.agents.length <= 1) {
      return;
    }

    agent.idleTimer = setTimeout(async () => {
      if (!agent.session.isRunning() && agent.currentRole === null) {
        console.log(`[ContextPool] Cleaning up idle agent ${agent.id}`);
        await this.removeAgent(agent);
      }
    }, POOL_CONFIG.idleTimeoutMs);
  }

  /**
   * Remove an agent from the pool.
   */
  private async removeAgent(agent: PooledAgent): Promise<void> {
    const index = this.agents.indexOf(agent);
    if (index !== -1) {
      this.agents.splice(index, 1);
      if (agent.idleTimer) {
        clearTimeout(agent.idleTimer);
      }
      await agent.session.cleanup();
      getAgentLimiter().release();
      console.log(`[ContextPool] Removed agent ${agent.id}, pool size: ${this.agents.length}`);
    }
  }

  /**
   * Get the context tape.
   */
  getContextTape(): ContextTape {
    return this.contextTape;
  }

  /**
   * Prune all context from a specific window.
   * Manual operation - not triggered automatically on window close.
   */
  pruneWindowContext(windowId: string): void {
    const pruned = this.contextTape.pruneWindow(windowId);
    console.log(`[ContextPool] Pruned ${pruned.length} messages from window ${windowId}`);
  }

  /**
   * Get the shared session logger.
   */
  getSessionLogger(): SessionLogger | null {
    return this.sharedLogger;
  }

  /**
   * Get the primary agent for operations that need a single agent.
   */
  getPrimaryAgent(): AgentSession | null {
    return this.agents[0]?.session ?? null;
  }

  /**
   * Interrupt all running agents.
   */
  async interruptAll(): Promise<void> {
    for (const agent of this.agents) {
      await agent.session.interrupt();
    }
  }

  /**
   * Interrupt a specific agent by ID.
   */
  async interruptAgent(agentId: string): Promise<boolean> {
    // Check if it's the default agent
    if (agentId === 'default') {
      await this.interruptAll();
      return true;
    }

    // Try to find agent by role
    for (const agent of this.agents) {
      if (agent.currentRole === agentId) {
        await agent.session.interrupt();
        return true;
      }
    }

    return false;
  }

  /**
   * Check if a window has an active agent.
   */
  hasActiveAgent(windowId: string): boolean {
    const role = `window-${windowId}`;
    return this.agents.some((a) => a.currentRole === role);
  }

  /**
   * Get the agent ID for a window (if any).
   */
  getWindowAgentId(windowId: string): string | undefined {
    return this.windowAgentMap.get(windowId);
  }

  /**
   * Send window agent status update.
   */
  private async sendWindowStatus(
    windowId: string,
    agentId: string,
    status: 'created' | 'active' | 'idle' | 'destroyed'
  ): Promise<void> {
    this.windowAgentMap.set(windowId, agentId);
    await this.sendEvent({
      type: 'WINDOW_AGENT_STATUS',
      windowId,
      agentId,
      status,
    });
  }

  /**
   * Format user interactions into context string.
   * Drawings are noted but not embedded (sent as native images to provider).
   */
  private formatInteractionsForContext(interactions: UserInteraction[]): string {
    if (interactions.length === 0) return '';

    // Separate drawings from other interactions
    const drawings = interactions.filter(i => i.type === 'draw' && i.imageData);
    const otherInteractions = interactions.filter(i => i.type !== 'draw');

    const parts: string[] = [];

    // Format non-drawing interactions
    if (otherInteractions.length > 0) {
      const lines = otherInteractions.map(i => {
        let content = '';
        if (i.windowTitle) content += `"${i.windowTitle}"`;
        if (i.details) content += content ? ` (${i.details})` : i.details;
        return `<user_interaction:${i.type}>${content}</user_interaction:${i.type}>`;
      });
      parts.push(`<previous_interactions>\n${lines.join('\n')}\n</previous_interactions>`);
    }

    // Note that drawings were attached (actual images sent separately to provider)
    if (drawings.length > 0) {
      parts.push(`<user_interaction:draw>[User drawing attached as image]</user_interaction:draw>`);
    }

    return parts.length > 0 ? parts.join('\n\n') + '\n\n' : '';
  }

  /**
   * Send an event to the client via broadcast center.
   */
  private async sendEvent(event: ServerEvent): Promise<void> {
    getBroadcastCenter().publishToConnection(event, this.connectionId);
  }

  /**
   * Get pool stats for monitoring.
   */
  getStats(): {
    totalAgents: number;
    idleAgents: number;
    busyAgents: number;
    mainQueueSize: number;
    windowQueueSizes: Record<string, number>;
    contextTapeSize: number;
  } {
    let idle = 0;
    let busy = 0;
    for (const agent of this.agents) {
      if (agent.session.isRunning() || agent.currentRole !== null) {
        busy++;
      } else {
        idle++;
      }
    }

    const windowQueueSizes: Record<string, number> = {};
    for (const [windowId, queue] of this.windowQueues) {
      if (queue.length > 0) {
        windowQueueSizes[windowId] = queue.length;
      }
    }

    return {
      totalAgents: this.agents.length,
      idleAgents: idle,
      busyAgents: busy,
      mainQueueSize: this.mainQueue.length,
      windowQueueSizes,
      contextTapeSize: this.contextTape.length,
    };
  }

  /**
   * Clean up all agents and resources.
   */
  async cleanup(): Promise<void> {
    const limiter = getAgentLimiter();
    for (const agent of this.agents) {
      if (agent.idleTimer) {
        clearTimeout(agent.idleTimer);
      }
      await agent.session.cleanup();
      limiter.release();
    }
    this.agents = [];
    this.mainQueue = [];
    this.windowAgentMap.clear();
    this.windowProcessing.clear();
    this.windowQueues.clear();
    this.contextTape.clear();
    this.sharedLogger = null;
  }
}
