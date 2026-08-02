/**
 * Shared types and interface for ContextPool processors.
 *
 * - `Task` / `QueuedTask` — moved here to break circular imports between context-pool <-> policies.
 * - `PoolContext` — the contract that MonitorTaskProcessor and AppTaskProcessor depend on.
 * - `AgentPoolStats` / `MonitorBudgetStats` / `PoolStats` — the stats contract read by
 *   `yaar://agents`, `yaar://windows/`, and `yaar://` (session read).
 */

import type { ServerEvent, UserInteraction } from '@yaar/shared';
import type { ContextTape } from './context.js';
import type { AgentPool } from './agent-pool.js';
import type { InteractionTimeline } from './interaction-timeline.js';
import type { WindowStateRegistry } from '../session/window-state.js';
import type { SessionLogger } from '../logging/index.js';
import type { ProviderType, TokenUsage } from '../providers/types.js';
import type { SessionId } from '../session/types.js';
import type {
  MonitorQueuePolicy,
  WindowQueuePolicy,
  ContextAssemblyPolicy,
  ReloadCachePolicy,
  MonitorBudgetPolicy,
  WindowSubscriptionPolicy,
} from './context-pool-policies/index.js';

/**
 * A task to be processed by the pool.
 */
export interface Task {
  type: 'monitor' | 'app' | 'session';
  messageId: string;
  windowId?: string;
  content: string;
  interactions?: UserInteraction[];
  actionId?: string; // For parallel button actions
  monitorId?: string; // Which monitor this task belongs to
  /** One-shot hook: notify the originating agent when this task completes. */
  hook?: 'response';
  /**
   * Run this app task on a brand-new app agent, dropping whatever the current one
   * remembers. App-tier only — a monitor agent is the desktop's continuity and has
   * nothing to be fresh from.
   */
  fresh?: boolean;
}

/**
 * A task waiting in a queue policy, stamped with when it was enqueued.
 */
export interface QueuedTask {
  task: Task;
  timestamp: number;
}

/**
 * Agent counts, as reported by `AgentPool.getStats()`.
 */
export interface AgentPoolStats {
  totalAgents: number;
  idleAgents: number;
  busyAgents: number;
  monitorAgents: number;
  appAgents: number;
  /**
   * App-tier sub-agents, across every app and monitor.
   *
   * Named `persona` because that is the wire name for this tier — the URI segment, the
   * spawn param, and the manifest field all say it. A total under the name the manifest
   * uses beats a rename that would have to be mirrored on the wire.
   */
  personaAgents: number;
  ephemeralAgents: number;
  sessionAgent: boolean;
  /**
   * Every agent's tokens summed, including agents already disposed — so the
   * figure only ever grows. `inputTokens` is fresh input; cache reads and writes
   * are counted separately and excluded from `inputTokens + outputTokens`.
   */
  usage: TokenUsage;
}

/**
 * Background-monitor budget usage, as reported by `MonitorBudgetPolicy.getStats()`.
 */
export interface MonitorBudgetStats {
  runningSlots: number;
  maxConcurrent: number;
  waitingCount: number;
  monitors: Record<string, { actionsInWindow: number; outputInWindow: number }>;
}

/**
 * The full pool snapshot returned by `ContextPool.getStats()` — agent counts
 * plus queue/context/budget gauges.
 */
export type PoolStats = AgentPoolStats & {
  monitorQueueSize: number;
  windowQueueSizes: Record<string, number>;
  contextTapeSize: number;
  timelineSize: number;
  monitorBudget: MonitorBudgetStats;
};

/**
 * The contract processors depend on — implemented by ContextPool.
 */
export interface PoolContext {
  readonly sessionId: SessionId;
  readonly agentPool: AgentPool;
  readonly contextTape: ContextTape;
  readonly windowState: WindowStateRegistry;
  readonly sharedLogger: SessionLogger | null;
  savedThreadIds?: Record<string, string>;
  readonly providerType: ProviderType | null;

  // Policies
  readonly contextAssembly: ContextAssemblyPolicy;
  readonly reloadPolicy: ReloadCachePolicy;
  readonly windowQueuePolicy: WindowQueuePolicy;
  readonly budgetPolicy: MonitorBudgetPolicy;
  readonly windowSubscriptionPolicy: WindowSubscriptionPolicy;

  // Methods processors call back into
  getOrCreateMonitorQueue(monitorId: string): MonitorQueuePolicy;
  /**
   * The interaction timeline of one monitor. There is no session-wide timeline: an
   * entry is drained into the next turn of the desktop it happened on, and no other.
   */
  timelineFor(monitorId: string): InteractionTimeline;
  sendEvent(event: ServerEvent): Promise<void>;
  /** Deliver a hook-triggered response notification to the monitor agent. */
  notifyHookResponse(
    appId: string,
    windowId: string,
    monitorId: string,
    responseText: string,
  ): void;
}
