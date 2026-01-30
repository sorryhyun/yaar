/**
 * DefaultAgentPool - manages a pool of default agents for concurrent message handling.
 *
 * When users send messages while the agent is already responding, this pool:
 * 1. Finds an idle agent from the pool
 * 2. If all busy and under limit, spawns a new agent
 * 3. If pool full, queues the message (with backpressure)
 *
 * All agents share the session logger for unified history.
 */

import { AgentSession } from './session.js';
import type { ServerEvent, UserInteraction } from '@claudeos/shared';
import type { SessionLogger } from '../logging/index.js';
import { getBroadcastCenter, type ConnectionId } from '../events/broadcast-center.js';
import { getAgentLimiter } from './limiter.js';

const POOL_CONFIG = {
  maxAgents: 3,
  maxQueueSize: 10,
  idleTimeoutMs: 300000, // 5 minutes
};

interface QueuedMessage {
  messageId: string;
  content: string;
  interactions?: UserInteraction[];
  timestamp: number;
}

interface PoolAgent {
  session: AgentSession;
  id: number;
  lastUsed: number;
  idleTimer: NodeJS.Timeout | null;
}

export class DefaultAgentPool {
  private connectionId: ConnectionId;
  private agents: PoolAgent[] = [];
  private messageQueue: QueuedMessage[] = [];
  private sharedLogger: SessionLogger | null = null;
  private nextAgentId = 0;
  private processingQueue = false;

  constructor(connectionId: ConnectionId) {
    this.connectionId = connectionId;
  }

  /**
   * Initialize the pool with the first agent.
   */
  async initialize(): Promise<boolean> {
    const firstAgent = await this.createAgent();
    if (!firstAgent) {
      return false;
    }

    // Capture the shared logger from the first agent
    this.sharedLogger = firstAgent.session.getSessionLogger();
    return true;
  }

  /**
   * Create a new agent in the pool.
   * Acquires a slot from the global agent limiter.
   */
  private async createAgent(): Promise<PoolAgent | null> {
    // Acquire global agent slot
    const limiter = getAgentLimiter();
    if (!limiter.tryAcquire()) {
      console.log('[DefaultAgentPool] Global agent limit reached, cannot create new agent');
      return null;
    }

    const id = this.nextAgentId++;
    const session = new AgentSession(
      this.connectionId,
      undefined,
      undefined,
      undefined,
      this.sharedLogger ?? undefined
    );

    const initialized = await session.initialize();
    if (!initialized) {
      // Release the slot if initialization failed
      limiter.release();
      return null;
    }

    const agent: PoolAgent = {
      session,
      id,
      lastUsed: Date.now(),
      idleTimer: null,
    };

    this.agents.push(agent);
    console.log(`[DefaultAgentPool] Created agent ${id}, pool size: ${this.agents.length}`);
    return agent;
  }

  /**
   * Find an idle agent from the pool.
   */
  private findIdleAgent(): PoolAgent | null {
    for (const agent of this.agents) {
      if (!agent.session.isRunning()) {
        return agent;
      }
    }
    return null;
  }

  /**
   * Handle an incoming user message.
   * Routes to an idle agent, spawns new agent if needed, or queues.
   */
  async handleMessage(
    messageId: string,
    content: string,
    interactions?: UserInteraction[]
  ): Promise<void> {
    // Try to find an idle agent
    let agent = this.findIdleAgent();

    if (agent) {
      // Use existing idle agent
      await this.assignToAgent(agent, messageId, content, interactions);
      return;
    }

    // No idle agents - try to spawn a new one
    if (this.agents.length < POOL_CONFIG.maxAgents) {
      agent = await this.createAgent();
      if (agent) {
        await this.assignToAgent(agent, messageId, content, interactions);
        return;
      }
    }

    // Pool full - queue the message
    if (this.messageQueue.length >= POOL_CONFIG.maxQueueSize) {
      // Backpressure: reject the message
      await this.sendEvent({
        type: 'ERROR',
        error: `Message queue is full (${POOL_CONFIG.maxQueueSize} messages). Please wait for current operations to complete.`,
      });
      return;
    }

    this.messageQueue.push({
      messageId,
      content,
      interactions,
      timestamp: Date.now(),
    });

    console.log(`[DefaultAgentPool] Queued message ${messageId}, queue size: ${this.messageQueue.length}`);

    // Notify frontend that message is queued
    await this.sendEvent({
      type: 'MESSAGE_QUEUED',
      messageId,
      position: this.messageQueue.length,
    });
  }

  /**
   * Assign a message to a specific agent and handle it.
   */
  private async assignToAgent(
    agent: PoolAgent,
    messageId: string,
    content: string,
    interactions?: UserInteraction[]
  ): Promise<void> {
    // Clear idle timer if any
    if (agent.idleTimer) {
      clearTimeout(agent.idleTimer);
      agent.idleTimer = null;
    }

    agent.lastUsed = Date.now();

    // Notify frontend that message is accepted
    await this.sendEvent({
      type: 'MESSAGE_ACCEPTED',
      messageId,
      agentId: agent.session.getSessionId(),
    });

    console.log(`[DefaultAgentPool] Assigned message ${messageId} to agent ${agent.id}`);

    // Process the message
    await agent.session.handleMessage(content, interactions, messageId);

    // Start idle timer for cleanup
    this.startIdleTimer(agent);

    // Process queue after completion
    await this.processQueue();
  }

  /**
   * Start idle timer for agent cleanup.
   */
  private startIdleTimer(agent: PoolAgent): void {
    // Don't cleanup the first agent (always keep at least one)
    if (agent.id === 0) {
      return;
    }

    agent.idleTimer = setTimeout(async () => {
      if (!agent.session.isRunning()) {
        console.log(`[DefaultAgentPool] Cleaning up idle agent ${agent.id}`);
        await this.removeAgent(agent);
      }
    }, POOL_CONFIG.idleTimeoutMs);
  }

  /**
   * Remove an agent from the pool.
   * Releases the slot back to the global agent limiter.
   */
  private async removeAgent(agent: PoolAgent): Promise<void> {
    const index = this.agents.indexOf(agent);
    if (index !== -1) {
      this.agents.splice(index, 1);
      if (agent.idleTimer) {
        clearTimeout(agent.idleTimer);
      }
      await agent.session.cleanup();
      // Release global agent slot
      getAgentLimiter().release();
      console.log(`[DefaultAgentPool] Removed agent ${agent.id}, pool size: ${this.agents.length}`);
    }
  }

  /**
   * Process queued messages when agents become available.
   */
  private async processQueue(): Promise<void> {
    if (this.processingQueue || this.messageQueue.length === 0) {
      return;
    }

    this.processingQueue = true;
    try {
      while (this.messageQueue.length > 0) {
        const agent = this.findIdleAgent();
        if (!agent) {
          // No idle agents available
          break;
        }

        const next = this.messageQueue.shift();
        if (next) {
          await this.assignToAgent(agent, next.messageId, next.content, next.interactions);
        }
      }
    } finally {
      this.processingQueue = false;
    }
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
   * Get the first agent (primary) for operations that need a single agent.
   * Used for setProvider, handleRenderingFeedback, etc.
   */
  getPrimaryAgent(): AgentSession | null {
    return this.agents[0]?.session ?? null;
  }

  /**
   * Get the shared session logger.
   */
  getSessionLogger(): SessionLogger | null {
    return this.sharedLogger;
  }

  /**
   * Get the raw session ID from the primary agent.
   */
  getRawSessionId(): string | null {
    return this.agents[0]?.session.getRawSessionId() ?? null;
  }

  /**
   * Send an event to the client via broadcast center.
   */
  private async sendEvent(event: ServerEvent): Promise<void> {
    getBroadcastCenter().publishToConnection(event, this.connectionId);
  }

  /**
   * Clean up all agents in the pool.
   * Releases all slots back to the global agent limiter.
   */
  async cleanup(): Promise<void> {
    const limiter = getAgentLimiter();
    for (const agent of this.agents) {
      if (agent.idleTimer) {
        clearTimeout(agent.idleTimer);
      }
      await agent.session.cleanup();
      // Release global agent slot
      limiter.release();
    }
    this.agents = [];
    this.messageQueue = [];
    this.sharedLogger = null;
  }

  /**
   * Get the base session ID for forking window agents.
   */
  getBaseSessionId(): string | null {
    return this.getRawSessionId();
  }
}
