/**
 * AgentPool - manages a pool of PooledAgent instances with lifecycle control.
 *
 * Handles agent creation, idle management, acquisition, and cleanup.
 * Used by ContextPool to decouple agent lifecycle from task orchestration.
 */

import { AgentSession } from './session.js';
import { getAgentLimiter } from './limiter.js';
import type { ConnectionId } from '../events/broadcast-center.js';
import type { SessionLogger } from '../logging/index.js';
import type { AITransport } from '../providers/types.js';

const POOL_CONFIG = {
  maxAgents: 5,
  idleTimeoutMs: 180000, // 3 minutes
};

/**
 * Internal pooled agent representation.
 */
export interface PooledAgent {
  session: AgentSession;
  id: number;
  instanceId: string;
  lastUsed: number;
  currentRole: string | null; // 'main-{messageId}' or 'window-{id}' when active
  idleTimer: NodeJS.Timeout | null;
}

export class AgentPool {
  private connectionId: ConnectionId;
  private agents: PooledAgent[] = [];
  private nextAgentId = 0;
  private logger: SessionLogger | null = null;

  constructor(connectionId: ConnectionId) {
    this.connectionId = connectionId;
  }

  setLogger(logger: SessionLogger): void {
    this.logger = logger;
  }

  /**
   * Create a new agent in the pool.
   */
  async createAgent(preWarmedProvider?: AITransport): Promise<PooledAgent | null> {
    const limiter = getAgentLimiter();
    if (!limiter.tryAcquire()) {
      console.log('[AgentPool] Global agent limit reached');
      return null;
    }

    const id = this.nextAgentId++;
    const instanceId = `agent-${id}-${Date.now()}`;

    const session = new AgentSession(
      this.connectionId,
      undefined,
      this.logger ?? undefined,
      instanceId,
    );

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
    console.log(`[AgentPool] Created agent ${id} (${instanceId}), pool size: ${this.agents.length}`);

    return agent;
  }

  /**
   * Find an idle agent (not running, no role assigned).
   */
  findIdle(): PooledAgent | null {
    for (const agent of this.agents) {
      if (!agent.session.isRunning() && agent.currentRole === null) {
        return agent;
      }
    }
    return null;
  }

  /**
   * Acquire an idle agent or create a new one, assigning the given role.
   */
  async acquire(role: string): Promise<PooledAgent | null> {
    const agent = this.findIdle();
    if (agent) {
      this.clearIdleTimer(agent);
      agent.currentRole = role;
      agent.lastUsed = Date.now();
      return agent;
    }

    if (this.agents.length < POOL_CONFIG.maxAgents) {
      const newAgent = await this.createAgent();
      if (newAgent) {
        newAgent.currentRole = role;
        return newAgent;
      }
    }

    return null;
  }

  /**
   * Release an agent back to idle and start its cleanup timer.
   */
  release(agent: PooledAgent): void {
    agent.currentRole = null;
    this.startIdleTimer(agent);
  }

  /**
   * Clear the idle timer on an agent.
   */
  clearIdleTimer(agent: PooledAgent): void {
    if (agent.idleTimer) {
      clearTimeout(agent.idleTimer);
      agent.idleTimer = null;
    }
  }

  /**
   * Start idle timer for agent cleanup.
   * Keeps at least one agent alive.
   */
  private startIdleTimer(agent: PooledAgent): void {
    if (agent.id === 0 || this.agents.length <= 1) {
      return;
    }

    agent.idleTimer = setTimeout(async () => {
      if (!agent.session.isRunning() && agent.currentRole === null) {
        console.log(`[AgentPool] Cleaning up idle agent ${agent.id}`);
        await this.removeAgent(agent);
      }
    }, POOL_CONFIG.idleTimeoutMs);
  }

  /**
   * Remove an agent from the pool and release its resources.
   */
  private async removeAgent(agent: PooledAgent): Promise<void> {
    const index = this.agents.indexOf(agent);
    if (index !== -1) {
      this.agents.splice(index, 1);
      this.clearIdleTimer(agent);
      await agent.session.cleanup();
      getAgentLimiter().release();
      console.log(`[AgentPool] Removed agent ${agent.id}, pool size: ${this.agents.length}`);
    }
  }

  /**
   * Get the primary (first) agent session.
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
   * Interrupt a specific agent by its current role.
   */
  async interruptByRole(role: string): Promise<boolean> {
    for (const agent of this.agents) {
      if (agent.currentRole === role) {
        await agent.session.interrupt();
        return true;
      }
    }
    return false;
  }

  /**
   * Check if any agent has the given role active.
   */
  hasRole(role: string): boolean {
    return this.agents.some((a) => a.currentRole === role);
  }

  /**
   * Check if any agent has a role starting with the given prefix.
   * Useful for checking if any agent is working on a window (role may include actionId suffix).
   */
  hasRolePrefix(prefix: string): boolean {
    return this.agents.some((a) => a.currentRole?.startsWith(prefix) ?? false);
  }

  /**
   * Get pool statistics.
   */
  getStats(): { totalAgents: number; idleAgents: number; busyAgents: number } {
    let idle = 0;
    let busy = 0;
    for (const agent of this.agents) {
      if (agent.session.isRunning() || agent.currentRole !== null) {
        busy++;
      } else {
        idle++;
      }
    }
    return { totalAgents: this.agents.length, idleAgents: idle, busyAgents: busy };
  }

  /**
   * Clean up all agents and release resources.
   * Interrupts all running queries first so handleMessage loops exit
   * before providers are disposed.
   */
  async cleanup(): Promise<void> {
    // Phase 1: interrupt all running agents so their query loops exit
    for (const agent of this.agents) {
      this.clearIdleTimer(agent);
      await agent.session.interrupt();
    }
    // Phase 2: dispose providers and release limiter slots
    const limiter = getAgentLimiter();
    for (const agent of this.agents) {
      await agent.session.cleanup();
      limiter.release();
    }
    this.agents = [];
  }
}
