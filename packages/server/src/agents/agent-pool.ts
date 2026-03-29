/**
 * AgentPool - manages agents with role-based lifecycle.
 *
 * Agent types:
 * - Monitor agents: persistent per-monitor, handle USER_MESSAGE, provider session continuity
 * - Ephemeral agents: fresh provider, no context, disposed after one task
 * - App agents: persistent per-app, handle app protocol communication
 *
 * Used by ContextPool to decouple agent lifecycle from task orchestration.
 */

import { AgentSession } from './session.js';
import { getAgentLimiter } from './limiter.js';
import { acquireWarmProvider } from '../providers/factory.js';
import { getSessionHub } from '../session/session-hub.js';
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
  currentRole: string | null; // 'monitor-{messageId}' or 'app-{id}' when active
  idleTimer: NodeJS.Timeout | null;
}

export class AgentPool {
  private sessionId: SessionId;
  private nextAgentId = 0;
  private logger: SessionLogger | null = null;
  private broadcastFn: (event: ServerEvent) => void;
  private resolveWindowHandle: (rawId: string, monitorId?: string) => string;

  /** Persistent monitor agents, keyed by monitorId. */
  private monitorAgents = new Map<string, PooledAgent>();

  /** Persistent per-app agents, keyed by appId. */
  private appAgents = new Map<string, PooledAgent>();

  /** Session agent — lazy singleton for cross-monitor oversight. */
  private sessionAgent: PooledAgent | null = null;

  /** Ephemeral agents currently in-flight (disposed after task). */
  private ephemeralAgents = new Set<PooledAgent>();

  /** All agent instanceIds for O(1) lookup. */
  private agentIds = new Set<string>();

  constructor(
    sessionId: SessionId,
    broadcast: (event: ServerEvent) => void,
    resolveWindowHandle?: (rawId: string, monitorId?: string) => string,
  ) {
    this.sessionId = sessionId;
    this.broadcastFn = broadcast;
    this.resolveWindowHandle = resolveWindowHandle ?? ((id) => id);
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
      this.resolveWindowHandle,
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

    this.agentIds.add(instanceId);
    getSessionHub().registerAgent(instanceId, this.sessionId);

    console.log(`[AgentPool] Created agent ${id} (${instanceId})`);
    return agent;
  }

  /**
   * Create a monitor agent for the given monitor with the given provider.
   */
  async createMonitorAgent(
    monitorId = '0',
    preWarmedProvider?: AITransport,
  ): Promise<PooledAgent | null> {
    const agent = await this.createAgentCore(preWarmedProvider);
    if (agent) {
      this.monitorAgents.set(monitorId, agent);
      console.log(`[AgentPool] Monitor agent created for ${monitorId}: ${agent.instanceId}`);
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
    this.agentIds.delete(agent.instanceId);
    getSessionHub().unregisterAgent(agent.instanceId);
    try {
      await agent.session.cleanup();
    } finally {
      getAgentLimiter().release();
    }
    console.log(`[AgentPool] Ephemeral agent disposed: ${agent.instanceId}`);
  }

  // ── Monitor agent ─────────────────────────────────────────────────────

  /**
   * Get the monitor agent for a monitor.
   */
  getMonitorAgent(monitorId = '0'): PooledAgent | null {
    return this.monitorAgents.get(monitorId) ?? null;
  }

  /**
   * Check if the monitor agent for a monitor is currently busy.
   */
  isMonitorAgentBusy(monitorId = '0'): boolean {
    const agent = this.monitorAgents.get(monitorId);
    if (!agent) return true; // no monitor agent = effectively busy
    return agent.session.isRunning() || agent.currentRole !== null;
  }

  /**
   * Get the monitor agent's session for a monitor.
   */
  getMonitorAgentSession(monitorId = '0'): AgentSession | null {
    return this.monitorAgents.get(monitorId)?.session ?? null;
  }

  /**
   * Check if a monitor agent exists for the given monitor.
   */
  hasMonitorAgent(monitorId: string): boolean {
    return this.monitorAgents.has(monitorId);
  }

  /**
   * Return the number of active monitor agents (one per monitor).
   */
  getMonitorAgentCount(): number {
    return this.monitorAgents.size;
  }

  /**
   * Return the monitor IDs that have monitor agents.
   */
  getMonitorAgentIds(): string[] {
    return [...this.monitorAgents.keys()];
  }

  /**
   * Remove and dispose the monitor agent for a given monitor.
   * Releases the limiter slot. Returns true if an agent was removed.
   */
  async removeMonitorAgent(monitorId: string): Promise<boolean> {
    const agent = this.monitorAgents.get(monitorId);
    if (!agent) return false;

    this.monitorAgents.delete(monitorId);
    this.agentIds.delete(agent.instanceId);
    getSessionHub().unregisterAgent(agent.instanceId);
    if (agent.session.isRunning()) {
      await agent.session.interrupt();
    }
    try {
      await agent.session.cleanup();
    } finally {
      getAgentLimiter().release();
    }
    console.log(`[AgentPool] Monitor agent removed for ${monitorId}: ${agent.instanceId}`);
    return true;
  }

  // ── App agents ───────────────────────────────────────────────────

  /**
   * Get or create a persistent app agent.
   * First call for an appId creates a fresh agent; subsequent calls reuse it.
   */
  async getOrCreateAppAgent(appId: string): Promise<PooledAgent | null> {
    const existing = this.appAgents.get(appId);
    if (existing) {
      console.log(`[AgentPool] Reusing app agent for ${appId}: ${existing.instanceId}`);
      return existing;
    }

    const provider = await acquireWarmProvider();
    const agent = await this.createAgentCore(provider ?? undefined);
    if (!agent) {
      if (provider) await provider.dispose();
      return null;
    }

    this.appAgents.set(appId, agent);
    console.log(`[AgentPool] App agent created for ${appId}: ${agent.instanceId}`);
    return agent;
  }

  /**
   * Check if an app agent exists for the given appId.
   */
  hasAppAgent(appId: string): boolean {
    return this.appAgents.has(appId);
  }

  /**
   * Get the count of active app agents.
   */
  getAppAgentCount(): number {
    return this.appAgents.size;
  }

  /**
   * Dispose the app agent for a given appId.
   */
  async disposeAppAgent(appId: string): Promise<void> {
    const agent = this.appAgents.get(appId);
    if (!agent) return;

    this.appAgents.delete(appId);
    this.agentIds.delete(agent.instanceId);
    getSessionHub().unregisterAgent(agent.instanceId);
    if (agent.session.isRunning()) {
      await agent.session.interrupt();
    }
    await agent.session.cleanup();
    getAgentLimiter().release();
    console.log(`[AgentPool] App agent disposed for ${appId}: ${agent.instanceId}`);
  }

  // ── Session agent ────────────────────────────────────────────────

  /**
   * Create the session agent (lazy singleton for cross-monitor oversight).
   */
  async createSessionAgent(): Promise<PooledAgent | null> {
    if (this.sessionAgent) return this.sessionAgent;

    const provider = await acquireWarmProvider();
    const agent = await this.createAgentCore(provider ?? undefined);
    if (!agent) {
      if (provider) await provider.dispose();
      return null;
    }

    this.sessionAgent = agent;
    console.log(`[AgentPool] Session agent created: ${agent.instanceId}`);
    return agent;
  }

  /**
   * Get the session agent (null if not created).
   */
  getSessionAgent(): PooledAgent | null {
    return this.sessionAgent;
  }

  /**
   * Check if the session agent exists.
   */
  hasSessionAgent(): boolean {
    return this.sessionAgent !== null;
  }

  /**
   * Dispose the session agent.
   */
  async disposeSessionAgent(): Promise<void> {
    const agent = this.sessionAgent;
    if (!agent) return;

    this.sessionAgent = null;
    this.agentIds.delete(agent.instanceId);
    getSessionHub().unregisterAgent(agent.instanceId);
    if (agent.session.isRunning()) {
      await agent.session.interrupt();
    }
    try {
      await agent.session.cleanup();
    } finally {
      getAgentLimiter().release();
    }
    console.log(`[AgentPool] Session agent disposed: ${agent.instanceId}`);
  }

  /**
   * Check if an agent with the given instanceId exists in this pool.
   */
  hasAgent(agentId: string): boolean {
    return this.agentIds.has(agentId);
  }

  /**
   * Find the monitorId for a given agent instanceId.
   */
  findMonitorForAgent(agentId: string): string | undefined {
    for (const [monitorId, agent] of this.monitorAgents) {
      if (agent.instanceId === agentId) return monitorId;
    }
    return undefined;
  }

  /**
   * Find the appId for a given agent instanceId (app agents only).
   */
  findAppIdForAgent(agentId: string): string | undefined {
    for (const [appId, agent] of this.appAgents) {
      if (agent.instanceId === agentId) return appId;
    }
    return undefined;
  }

  // ── Steer ──────────────────────────────────────────────────────────

  /**
   * Try to steer the monitor agent's active turn with additional input.
   * Returns true if steering succeeded, false otherwise.
   */
  async steerMonitorAgent(monitorId = '0', content: string): Promise<boolean> {
    const agent = this.monitorAgents.get(monitorId);
    if (!agent || !agent.session.isRunning()) return false;
    return agent.session.steer(content);
  }

  /**
   * Try to steer an app agent's active turn with additional input.
   * Returns true if steering succeeded, false otherwise.
   */
  async steerAppAgent(appId: string, content: string): Promise<boolean> {
    const agent = this.appAgents.get(appId);
    if (!agent || !agent.session.isRunning()) return false;
    return agent.session.steer(content);
  }

  // ── Query / interrupt ───────────────────────────────────────────────

  /**
   * Interrupt all running agents (monitor, app, ephemeral).
   */
  async interruptAll(): Promise<void> {
    if (this.sessionAgent) await this.sessionAgent.session.interrupt();
    for (const agent of this.monitorAgents.values()) {
      await agent.session.interrupt();
    }
    for (const agent of this.appAgents.values()) {
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
    // Check session agent
    if (this.sessionAgent?.currentRole === role) {
      await this.sessionAgent.session.interrupt();
      return true;
    }
    // Check monitor agents
    for (const agent of this.monitorAgents.values()) {
      if (agent.currentRole === role) {
        await agent.session.interrupt();
        return true;
      }
    }
    // Check app agents
    for (const agent of this.appAgents.values()) {
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
    if (this.sessionAgent?.currentRole?.startsWith(prefix)) return true;
    for (const agent of this.monitorAgents.values()) {
      if (agent.currentRole?.startsWith(prefix)) return true;
    }
    for (const agent of this.appAgents.values()) {
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
    monitorAgent: boolean;
    monitorAgents: number;
    appAgents: number;
    ephemeralAgents: number;
    sessionAgent: boolean;
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

    if (this.sessionAgent) countAgent(this.sessionAgent);
    for (const agent of this.monitorAgents.values()) countAgent(agent);
    for (const agent of this.appAgents.values()) countAgent(agent);
    for (const agent of this.ephemeralAgents) countAgent(agent);

    return {
      totalAgents: total,
      idleAgents: idle,
      busyAgents: busy,
      monitorAgent: this.monitorAgents.size > 0,
      monitorAgents: this.monitorAgents.size,
      appAgents: this.appAgents.size,
      ephemeralAgents: this.ephemeralAgents.size,
      sessionAgent: this.sessionAgent !== null,
    };
  }

  // ── Cleanup ────────────────────────────────────────────────────────

  /**
   * Clean up all agents and release resources.
   */
  async cleanup(): Promise<void> {
    const limiter = getAgentLimiter();
    const allAgents: PooledAgent[] = [];

    if (this.sessionAgent) allAgents.push(this.sessionAgent);
    for (const agent of this.monitorAgents.values()) allAgents.push(agent);
    for (const agent of this.appAgents.values()) allAgents.push(agent);
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

    this.sessionAgent = null;
    this.monitorAgents.clear();
    this.appAgents.clear();
    this.ephemeralAgents.clear();
    for (const id of this.agentIds) {
      getSessionHub().unregisterAgent(id);
    }
    this.agentIds.clear();
  }
}
