/**
 * WindowAgentPool - Shared pool for parallel window message handling.
 *
 * Unlike dedicated per-window agents, this pool:
 * 1. Maintains a pool of reusable agents
 * 2. Forks session context per-message for window isolation
 * 3. Processes window messages in parallel (not sequentially)
 * 4. Returns agents to pool after use
 * 5. Tracks window parentage for proper session forking
 *
 * This enables concurrent window processing while maintaining context.
 * When window A creates window B, interactions with B fork from A's session.
 */

import { AgentSession } from './session.js';
import type { ServerEvent, UserInteraction } from '@claudeos/shared';
import type { SessionLogger } from '../logging/index.js';
import { getBroadcastCenter, type ConnectionId } from '../events/broadcast-center.js';
import { getAgentLimiter } from './limiter.js';
import { actionEmitter, type ActionEvent } from '../tools/action-emitter.js';

const POOL_CONFIG = {
  maxAgents: 5,
  idleTimeoutMs: 180000, // 3 minutes
};

interface PooledAgent {
  session: AgentSession;
  id: number;
  instanceId: string; // Unique ID for this agent instance (e.g., 'window-storage-browser-0')
  lastUsed: number;
  currentWindowId: string | null;
  idleTimer: NodeJS.Timeout | null;
}

interface WindowAgentStatus {
  agentId: string;
  windowId: string;
  status: 'created' | 'active' | 'idle' | 'destroyed';
}

export class WindowAgentPool {
  private connectionId: ConnectionId;
  private sharedLogger?: SessionLogger;
  private getBaseSessionId: () => string | undefined;
  private agents: PooledAgent[] = [];
  private nextAgentId = 0;
  private windowAgentMap: Map<string, string> = new Map(); // windowId -> agentId for status tracking
  private windowParentMap: Map<string, string> = new Map(); // windowId -> parentAgentId (who created this window)
  private agentSessionRefs: Map<string, AgentSession> = new Map(); // agentId -> AgentSession (for looking up parent sessions)
  private unsubscribeAction: (() => void) | null = null;

  constructor(
    connectionId: ConnectionId,
    sharedLogger?: SessionLogger,
    getBaseSessionId?: () => string | undefined
  ) {
    this.connectionId = connectionId;
    this.sharedLogger = sharedLogger;
    this.getBaseSessionId = getBaseSessionId ?? (() => undefined);

    // Subscribe to action emitter to track window creation parentage
    this.unsubscribeAction = actionEmitter.onAction(this.handleActionEvent.bind(this));
  }

  /**
   * Handle action events to track window parentage.
   * When a window agent creates a new window, we track the relationship.
   */
  private handleActionEvent(event: ActionEvent): void {
    const action = event.action as { type: string; windowId?: string };

    // Only track window.create actions from window agents
    if (action.type === 'window.create' && event.agentId) {
      // Check if this action is from a window agent (uses instanceId format: window-{windowId}-{id})
      if (event.agentId.startsWith('window-') && event.agentId !== 'default') {
        const newWindowId = action.windowId;
        if (newWindowId) {
          // Use the full instanceId as parent reference
          this.windowParentMap.set(newWindowId, event.agentId);
          console.log(`[WindowAgentPool] Tracked parentage: ${newWindowId} <- ${event.agentId}`);
        }
      }
    }
  }

  /**
   * Get the session ID to fork from for a given window.
   * If the window was created by another window agent, fork from that agent's session.
   * Otherwise, fork from the default agent's base session.
   */
  private getForkSessionId(windowId: string): string | undefined {
    // Check if this window has a parent window agent
    const parentAgentId = this.windowParentMap.get(windowId);
    if (parentAgentId) {
      // Look up the parent agent's session (dynamically get session ID)
      const parentSession = this.agentSessionRefs.get(parentAgentId);
      const parentSessionId = parentSession?.getRawSessionId();
      if (parentSessionId) {
        console.log(`[WindowAgentPool] Window ${windowId} forking from parent ${parentAgentId} session ${parentSessionId}`);
        return parentSessionId;
      }
      console.log(`[WindowAgentPool] Window ${windowId} has parent ${parentAgentId} but no session ID yet, using base session`);
    }

    // Fall back to default agent's base session
    return this.getBaseSessionId();
  }

  /**
   * Handle a message for a specific window.
   * Acquires an agent from the pool, injects window context, processes message, returns agent.
   */
  async handleMessage(
    messageId: string,
    windowId: string,
    content: string,
    interactions?: UserInteraction[]
  ): Promise<void> {
    console.log(`[WindowAgentPool] handleMessage started: ${messageId} for ${windowId}, content: "${content.slice(0, 50)}..."`);

    // Acquire global agent slot (with timeout)
    const limiter = getAgentLimiter();
    try {
      await limiter.acquire(30000); // 30 second timeout
    } catch (err) {
      console.error(`[WindowAgentPool] Failed to acquire limiter for ${messageId}:`, err);
      await this.sendEvent({
        type: 'ERROR',
        error: `Failed to acquire agent slot: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    console.log(`[WindowAgentPool] Limiter acquired for ${messageId}`);

    try {
      // Get or create an agent from the pool
      const agent = await this.acquireAgent(windowId);
      if (!agent) {
        limiter.release();
        console.error(`[WindowAgentPool] Failed to acquire agent for ${messageId}`);
        await this.sendEvent({
          type: 'ERROR',
          error: `Failed to acquire window agent for ${windowId}`,
        });
        return;
      }

      console.log(`[WindowAgentPool] Agent acquired for ${messageId}: ${agent.instanceId}`);

      // Notify frontend that message is accepted
      await this.sendEvent({
        type: 'MESSAGE_ACCEPTED',
        messageId,
        agentId: agent.session.getSessionId(),
      });

      // Update window agent status
      await this.sendWindowStatus(windowId, agent.session.getSessionId(), 'active');

      // Process the message - each agent processes its own content
      console.log(`[WindowAgentPool] Starting handleMessage for ${agent.instanceId}, content: "${content}"`);
      await agent.session.handleMessage(content, interactions, messageId);
      console.log(`[WindowAgentPool] Finished handleMessage for ${agent.instanceId}`);

      // Mark agent as available
      agent.currentWindowId = null;
      this.startIdleTimer(agent);

      // Send idle status
      await this.sendWindowStatus(windowId, agent.session.getSessionId(), 'idle');
    } finally {
      // Release the global slot after processing
      limiter.release();
    }
  }

  /**
   * Handle a component action for a specific window.
   */
  async handleComponentAction(windowId: string, action: string): Promise<void> {
    const messageId = `component-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    await this.handleMessage(messageId, windowId, action);
  }

  /**
   * Acquire an agent from the pool for a specific window.
   */
  private async acquireAgent(windowId: string): Promise<PooledAgent | null> {
    // Try to find an idle agent
    for (const agent of this.agents) {
      if (!agent.session.isRunning() && agent.currentWindowId === null) {
        // Clear idle timer
        if (agent.idleTimer) {
          clearTimeout(agent.idleTimer);
          agent.idleTimer = null;
        }

        // Assign to window
        agent.currentWindowId = windowId;
        agent.lastUsed = Date.now();
        this.windowAgentMap.set(windowId, agent.session.getSessionId());
        return agent;
      }
    }

    // No idle agent - try to create a new one if under limit
    if (this.agents.length < POOL_CONFIG.maxAgents) {
      const agent = await this.createAgent(windowId);
      return agent;
    }

    // Pool full - this shouldn't normally happen due to global limiter
    // but handle gracefully
    console.warn('[WindowAgentPool] Pool full, message will be processed when agent available');
    return null;
  }

  /**
   * Create a new agent in the pool.
   */
  private async createAgent(windowId: string): Promise<PooledAgent | null> {
    const id = this.nextAgentId++;
    // Create unique instance ID for this specific agent (not reused across messages)
    const instanceId = `window-${windowId}-${id}`;

    // Get session ID to fork from (parent window agent or default agent)
    const forkSessionId = this.getForkSessionId(windowId);

    // Determine parent agent ID for logging hierarchy
    const parentAgentId = this.windowParentMap.get(windowId) ?? 'default';

    // Create agent session with fork context, parent info, and unique instance ID
    const session = new AgentSession(
      this.connectionId,
      undefined,
      windowId,
      forkSessionId,
      this.sharedLogger,
      parentAgentId,
      instanceId // Pass unique instance ID for action filtering
    );

    const initialized = await session.initialize();
    if (!initialized) {
      return null;
    }

    const agent: PooledAgent = {
      session,
      id,
      instanceId,
      lastUsed: Date.now(),
      currentWindowId: windowId,
      idleTimer: null,
    };

    this.agents.push(agent);

    // Track both window->agent and agent->session mappings
    const agentId = session.getSessionId();
    this.windowAgentMap.set(windowId, agentId);
    // Store session reference for dynamic session ID lookup (for child window forking)
    // Use instanceId as key since multiple agents may exist per window
    this.agentSessionRefs.set(instanceId, session);

    console.log(`[WindowAgentPool] Created agent ${id} (${instanceId}) for window ${windowId}, pool size: ${this.agents.length}`);

    // Notify frontend about new agent
    await this.sendWindowStatus(windowId, agentId, 'created');

    return agent;
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
      if (!agent.session.isRunning() && agent.currentWindowId === null) {
        console.log(`[WindowAgentPool] Cleaning up idle agent ${agent.id}`);
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
      console.log(`[WindowAgentPool] Removed agent ${agent.id}, pool size: ${this.agents.length}`);
    }
  }

  /**
   * Interrupt a specific window's agent.
   */
  async interruptWindow(windowId: string): Promise<boolean> {
    for (const agent of this.agents) {
      if (agent.currentWindowId === windowId) {
        await agent.session.interrupt();
        return true;
      }
    }
    return false;
  }

  /**
   * Interrupt an agent by ID.
   */
  async interruptAgent(agentId: string): Promise<boolean> {
    for (const agent of this.agents) {
      if (agent.session.getSessionId() === agentId) {
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
    return this.windowAgentMap.has(windowId);
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
    status: WindowAgentStatus['status']
  ): Promise<void> {
    await this.sendEvent({
      type: 'WINDOW_AGENT_STATUS',
      windowId,
      agentId,
      status,
    });
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
  } {
    let idle = 0;
    let busy = 0;
    for (const agent of this.agents) {
      if (agent.session.isRunning()) {
        busy++;
      } else {
        idle++;
      }
    }
    return {
      totalAgents: this.agents.length,
      idleAgents: idle,
      busyAgents: busy,
    };
  }

  /**
   * Clean up all agents in the pool.
   */
  async cleanup(): Promise<void> {
    // Unsubscribe from action emitter
    if (this.unsubscribeAction) {
      this.unsubscribeAction();
      this.unsubscribeAction = null;
    }

    for (const agent of this.agents) {
      if (agent.idleTimer) {
        clearTimeout(agent.idleTimer);
      }
      await agent.session.cleanup();
    }
    this.agents = [];
    this.windowAgentMap.clear();
    this.windowParentMap.clear();
    this.agentSessionRefs.clear();
  }
}
