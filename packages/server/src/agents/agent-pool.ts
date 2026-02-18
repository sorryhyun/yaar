/**
 * AgentPool - manages agents with role-based lifecycle.
 *
 * Three agent types:
 * - Main agents: persistent per-monitor, handle USER_MESSAGE, provider session continuity
 * - Ephemeral agents: fresh provider, no context, disposed after one task
 * - Window agents: persistent per-window, fresh provider + initial context
 *
 * Used by ContextPool to decouple agent lifecycle from task orchestration.
 */

import { AgentSession } from './session.js';
import { getAgentLimiter } from './limiter.js';
import { acquireWarmProvider } from '../providers/factory.js';
import type { ServerEvent } from '@yaar/shared';
import type { SessionId } from '../session/types.js';
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
  private sessionId: SessionId;
  private nextAgentId = 0;
  private logger: SessionLogger | null = null;
  private broadcastFn: (event: ServerEvent) => void;

  /** Persistent main agents, keyed by monitorId. */
  private mainAgents = new Map<string, PooledAgent>();

  /** Persistent per-window agents, keyed by windowId. */
  private windowAgents = new Map<string, PooledAgent>();

  /** Ephemeral agents currently in-flight (disposed after task). */
  private ephemeralAgents = new Set<PooledAgent>();

  /** Task agents currently in-flight (disposed after dispatch_task completes). */
  private taskAgents = new Set<PooledAgent>();

  constructor(sessionId: SessionId, broadcast: (event: ServerEvent) => void) {
    this.sessionId = sessionId;
    this.broadcastFn = broadcast;
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
      this.sessionId, // connectionId (legacy, used as fallback)
      undefined,
      this.logger ?? undefined,
      instanceId,
      this.sessionId, // liveSessionId for session-scoped broadcasting
      this.broadcastFn,
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
   * Create a main agent for the given monitor with the given provider.
   */
  async createMainAgent(
    monitorId = 'monitor-0',
    preWarmedProvider?: AITransport,
  ): Promise<PooledAgent | null> {
    const agent = await this.createAgentCore(preWarmedProvider);
    if (agent) {
      this.mainAgents.set(monitorId, agent);
      console.log(`[AgentPool] Main agent created for ${monitorId}: ${agent.instanceId}`);
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
    try {
      await agent.session.cleanup();
    } finally {
      getAgentLimiter().release();
    }
    console.log(`[AgentPool] Ephemeral agent disposed: ${agent.instanceId}`);
  }

  // ── Task agents ──────────────────────────────────────────────────

  /**
   * Create a task agent for dispatch_task.
   * Uses a warm provider. The caller is responsible for calling disposeTaskAgent() after the task.
   */
  async createTaskAgent(): Promise<PooledAgent | null> {
    const provider = await acquireWarmProvider();
    const agent = await this.createAgentCore(provider ?? undefined);
    if (!agent) {
      if (provider) await provider.dispose();
      return null;
    }
    this.taskAgents.add(agent);
    console.log(`[AgentPool] Task agent created: ${agent.instanceId}`);
    return agent;
  }

  /**
   * Dispose a task agent after its dispatch completes.
   */
  async disposeTaskAgent(agent: PooledAgent): Promise<void> {
    this.taskAgents.delete(agent);
    try {
      await agent.session.cleanup();
    } finally {
      getAgentLimiter().release();
    }
    console.log(`[AgentPool] Task agent disposed: ${agent.instanceId}`);
  }

  // ── Main agent ─────────────────────────────────────────────────────

  /**
   * Get the main agent for a monitor.
   */
  getMainAgent(monitorId = 'monitor-0'): PooledAgent | null {
    return this.mainAgents.get(monitorId) ?? null;
  }

  /**
   * Check if the main agent for a monitor is currently busy.
   */
  isMainAgentBusy(monitorId = 'monitor-0'): boolean {
    const agent = this.mainAgents.get(monitorId);
    if (!agent) return true; // no main agent = effectively busy
    return agent.session.isRunning() || agent.currentRole !== null;
  }

  /**
   * Get the main agent's session for a monitor.
   */
  getMainAgentSession(monitorId = 'monitor-0'): AgentSession | null {
    return this.mainAgents.get(monitorId)?.session ?? null;
  }

  /**
   * Check if a main agent exists for the given monitor.
   */
  hasMainAgent(monitorId: string): boolean {
    return this.mainAgents.has(monitorId);
  }

  /**
   * Return the number of active main agents (one per monitor).
   */
  getMainAgentCount(): number {
    return this.mainAgents.size;
  }

  /**
   * Return the monitor IDs that have main agents.
   */
  getMainAgentMonitorIds(): string[] {
    return [...this.mainAgents.keys()];
  }

  /**
   * Remove and dispose the main agent for a given monitor.
   * Releases the limiter slot. Returns true if an agent was removed.
   */
  async removeMainAgent(monitorId: string): Promise<boolean> {
    const agent = this.mainAgents.get(monitorId);
    if (!agent) return false;

    this.mainAgents.delete(monitorId);
    if (agent.session.isRunning()) {
      await agent.session.interrupt();
    }
    try {
      await agent.session.cleanup();
    } finally {
      getAgentLimiter().release();
    }
    console.log(`[AgentPool] Main agent removed for ${monitorId}: ${agent.instanceId}`);
    return true;
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

  // ── Steer ──────────────────────────────────────────────────────────

  /**
   * Try to steer the main agent's active turn with additional input.
   * Returns true if steering succeeded, false otherwise.
   */
  async steerMainAgent(monitorId = 'monitor-0', content: string): Promise<boolean> {
    const agent = this.mainAgents.get(monitorId);
    if (!agent || !agent.session.isRunning()) return false;
    return agent.session.steer(content);
  }

  // ── Query / interrupt ───────────────────────────────────────────────

  /**
   * Interrupt all running agents (main, window, ephemeral).
   */
  async interruptAll(): Promise<void> {
    for (const agent of this.mainAgents.values()) {
      await agent.session.interrupt();
    }
    for (const agent of this.windowAgents.values()) {
      await agent.session.interrupt();
    }
    for (const agent of this.ephemeralAgents) {
      await agent.session.interrupt();
    }
    for (const agent of this.taskAgents) {
      await agent.session.interrupt();
    }
  }

  /**
   * Interrupt a specific agent by its current role.
   */
  async interruptByRole(role: string): Promise<boolean> {
    // Check main agents
    for (const agent of this.mainAgents.values()) {
      if (agent.currentRole === role) {
        await agent.session.interrupt();
        return true;
      }
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
    // Check task agents
    for (const agent of this.taskAgents) {
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
    for (const agent of this.mainAgents.values()) {
      if (agent.currentRole?.startsWith(prefix)) return true;
    }
    for (const agent of this.windowAgents.values()) {
      if (agent.currentRole?.startsWith(prefix)) return true;
    }
    for (const agent of this.ephemeralAgents) {
      if (agent.currentRole?.startsWith(prefix)) return true;
    }
    for (const agent of this.taskAgents) {
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
    mainAgents: number;
    windowAgents: number;
    ephemeralAgents: number;
    taskAgents: number;
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

    for (const agent of this.mainAgents.values()) countAgent(agent);
    for (const agent of this.windowAgents.values()) countAgent(agent);
    for (const agent of this.ephemeralAgents) countAgent(agent);
    for (const agent of this.taskAgents) countAgent(agent);

    return {
      totalAgents: total,
      idleAgents: idle,
      busyAgents: busy,
      mainAgent: this.mainAgents.size > 0,
      mainAgents: this.mainAgents.size,
      windowAgents: this.windowAgents.size,
      ephemeralAgents: this.ephemeralAgents.size,
      taskAgents: this.taskAgents.size,
    };
  }

  // ── Cleanup ────────────────────────────────────────────────────────

  /**
   * Clean up all agents and release resources.
   */
  async cleanup(): Promise<void> {
    const limiter = getAgentLimiter();
    const allAgents: PooledAgent[] = [];

    for (const agent of this.mainAgents.values()) allAgents.push(agent);
    for (const agent of this.windowAgents.values()) allAgents.push(agent);
    for (const agent of this.ephemeralAgents) allAgents.push(agent);
    for (const agent of this.taskAgents) allAgents.push(agent);

    // Phase 1: interrupt all running agents
    for (const agent of allAgents) {
      await agent.session.interrupt();
    }

    // Phase 2: dispose providers and release limiter slots
    for (const agent of allAgents) {
      await agent.session.cleanup();
      limiter.release();
    }

    this.mainAgents.clear();
    this.windowAgents.clear();
    this.ephemeralAgents.clear();
    this.taskAgents.clear();
  }
}
