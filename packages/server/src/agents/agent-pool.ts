/**
 * AgentPool - manages agents with role-based lifecycle.
 *
 * Three agent types:
 * - Main agent (id=0): persistent, handles USER_MESSAGE, provider session continuity
 * - Ephemeral agents: fresh provider, no context, disposed after one task
 * - Window agents: persistent per-window, fresh provider + initial context
 *
 * Used by ContextPool to decouple agent lifecycle from task orchestration.
 */

import { AgentSession } from './session.js';
import { getAgentLimiter } from './limiter.js';
import { acquireWarmProvider } from '../providers/factory.js';
import type { ConnectionId } from '../websocket/broadcast-center.js';
import type { SessionLogger } from '../logging/index.js';
import type { AITransport } from '../providers/types.js';

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
  private nextAgentId = 0;
  private logger: SessionLogger | null = null;

  /** The single persistent main agent. */
  private mainAgent: PooledAgent | null = null;

  /** Persistent per-window agents, keyed by windowId. */
  private windowAgents = new Map<string, PooledAgent>();

  /** Ephemeral agents currently in-flight (disposed after task). */
  private ephemeralAgents = new Set<PooledAgent>();

  constructor(connectionId: ConnectionId) {
    this.connectionId = connectionId;
  }

  setLogger(logger: SessionLogger): void {
    this.logger = logger;
  }

  // ── Agent creation ───────────────────────────────────────────────────

  /**
   * Create a new agent session with a provider.
   * Does NOT add it to any tracked collection — caller must manage lifecycle.
   */
  private async createAgentCore(preWarmedProvider?: AITransport): Promise<PooledAgent | null> {
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

    console.log(`[AgentPool] Created agent ${id} (${instanceId})`);
    return agent;
  }

  /**
   * Create the main agent (agent-0) with the given provider.
   * Called once during pool initialization.
   */
  async createMainAgent(preWarmedProvider?: AITransport): Promise<PooledAgent | null> {
    const agent = await this.createAgentCore(preWarmedProvider);
    if (agent) {
      this.mainAgent = agent;
      console.log(`[AgentPool] Main agent created: ${agent.instanceId}`);
    }
    return agent;
  }

  /**
   * Create an ephemeral agent with a fresh provider.
   * The caller is responsible for calling disposeEphemeral() after the task.
   */
  async createEphemeral(): Promise<PooledAgent | null> {
    const provider = await acquireWarmProvider();
    const agent = await this.createAgentCore(provider ?? undefined);
    if (!agent) {
      if (provider) await provider.dispose();
      return null;
    }
    this.ephemeralAgents.add(agent);
    console.log(`[AgentPool] Ephemeral agent created: ${agent.instanceId}`);
    return agent;
  }

  /**
   * Dispose an ephemeral agent after its task completes.
   */
  async disposeEphemeral(agent: PooledAgent): Promise<void> {
    this.ephemeralAgents.delete(agent);
    await agent.session.cleanup();
    getAgentLimiter().release();
    console.log(`[AgentPool] Ephemeral agent disposed: ${agent.instanceId}`);
  }

  // ── Main agent ─────────────────────────────────────────────────────

  /**
   * Get the main agent.
   */
  getMainAgent(): PooledAgent | null {
    return this.mainAgent;
  }

  /**
   * Check if the main agent is currently busy.
   */
  isMainAgentBusy(): boolean {
    if (!this.mainAgent) return true; // no main agent = effectively busy
    return this.mainAgent.session.isRunning() || this.mainAgent.currentRole !== null;
  }

  /**
   * Get the main agent's session (for session ID access, provider changes, etc).
   */
  getMainAgentSession(): AgentSession | null {
    return this.mainAgent?.session ?? null;
  }

  // ── Window agents ──────────────────────────────────────────────────

  /**
   * Get or create a persistent window agent.
   * First call for a windowId creates a fresh agent; subsequent calls reuse it.
   */
  async getOrCreateWindowAgent(windowId: string): Promise<PooledAgent | null> {
    const existing = this.windowAgents.get(windowId);
    if (existing) {
      console.log(`[AgentPool] Reusing window agent for ${windowId}: ${existing.instanceId}`);
      return existing;
    }

    const provider = await acquireWarmProvider();
    const agent = await this.createAgentCore(provider ?? undefined);
    if (!agent) {
      if (provider) await provider.dispose();
      return null;
    }

    this.windowAgents.set(windowId, agent);
    console.log(`[AgentPool] Window agent created for ${windowId}: ${agent.instanceId}`);
    return agent;
  }

  /**
   * Check if a window agent exists for the given windowId.
   */
  hasWindowAgent(windowId: string): boolean {
    return this.windowAgents.has(windowId);
  }

  /**
   * Dispose the window agent for a given windowId.
   */
  async disposeWindowAgent(windowId: string): Promise<void> {
    const agent = this.windowAgents.get(windowId);
    if (!agent) return;

    this.windowAgents.delete(windowId);
    if (agent.session.isRunning()) {
      await agent.session.interrupt();
    }
    await agent.session.cleanup();
    getAgentLimiter().release();
    console.log(`[AgentPool] Window agent disposed for ${windowId}: ${agent.instanceId}`);
  }

  // ── Query / interrupt ───────────────────────────────────────────────

  /**
   * Interrupt all running agents (main, window, ephemeral).
   */
  async interruptAll(): Promise<void> {
    if (this.mainAgent) {
      await this.mainAgent.session.interrupt();
    }
    for (const agent of this.windowAgents.values()) {
      await agent.session.interrupt();
    }
    for (const agent of this.ephemeralAgents) {
      await agent.session.interrupt();
    }
  }

  /**
   * Interrupt a specific agent by its current role.
   */
  async interruptByRole(role: string): Promise<boolean> {
    // Check main agent
    if (this.mainAgent?.currentRole === role) {
      await this.mainAgent.session.interrupt();
      return true;
    }
    // Check window agents
    for (const agent of this.windowAgents.values()) {
      if (agent.currentRole === role) {
        await agent.session.interrupt();
        return true;
      }
    }
    // Check ephemeral agents
    for (const agent of this.ephemeralAgents) {
      if (agent.currentRole === role) {
        await agent.session.interrupt();
        return true;
      }
    }
    return false;
  }

  /**
   * Check if any agent has a role starting with the given prefix.
   */
  hasRolePrefix(prefix: string): boolean {
    if (this.mainAgent?.currentRole?.startsWith(prefix)) return true;
    for (const agent of this.windowAgents.values()) {
      if (agent.currentRole?.startsWith(prefix)) return true;
    }
    for (const agent of this.ephemeralAgents) {
      if (agent.currentRole?.startsWith(prefix)) return true;
    }
    return false;
  }

  // ── Stats ──────────────────────────────────────────────────────────

  /**
   * Get pool statistics.
   */
  getStats(): {
    totalAgents: number;
    idleAgents: number;
    busyAgents: number;
    mainAgent: boolean;
    windowAgents: number;
    ephemeralAgents: number;
  } {
    let total = 0;
    let idle = 0;
    let busy = 0;

    const countAgent = (agent: PooledAgent) => {
      total++;
      if (agent.session.isRunning() || agent.currentRole !== null) {
        busy++;
      } else {
        idle++;
      }
    };

    if (this.mainAgent) countAgent(this.mainAgent);
    for (const agent of this.windowAgents.values()) countAgent(agent);
    for (const agent of this.ephemeralAgents) countAgent(agent);

    return {
      totalAgents: total,
      idleAgents: idle,
      busyAgents: busy,
      mainAgent: this.mainAgent !== null,
      windowAgents: this.windowAgents.size,
      ephemeralAgents: this.ephemeralAgents.size,
    };
  }

  // ── Cleanup ────────────────────────────────────────────────────────

  /**
   * Clean up all agents and release resources.
   */
  async cleanup(): Promise<void> {
    const limiter = getAgentLimiter();
    const allAgents: PooledAgent[] = [];

    if (this.mainAgent) allAgents.push(this.mainAgent);
    for (const agent of this.windowAgents.values()) allAgents.push(agent);
    for (const agent of this.ephemeralAgents) allAgents.push(agent);

    // Phase 1: interrupt all running agents
    for (const agent of allAgents) {
      await agent.session.interrupt();
    }

    // Phase 2: dispose providers and release limiter slots
    for (const agent of allAgents) {
      await agent.session.cleanup();
      limiter.release();
    }

    this.mainAgent = null;
    this.windowAgents.clear();
    this.ephemeralAgents.clear();
  }
}
