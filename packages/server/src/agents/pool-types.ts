/**
 * Shared types and interface for ContextPool processors.
 *
 * - `Task` / `QueuedTask` — moved here to break circular imports between context-pool <-> policies.
 * - `TurnContext` and the four per-collaborator tiers narrowed from it; `PoolContext` is
 *   their union, implemented by `ContextPool`. A processor depends on its own tier.
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
 * Who produced a task. The one field routing is allowed to branch on.
 *
 * `MonitorTaskProcessor` used to answer this question by sniffing the *messageId* for
 * `relay-` and `hook-resp-` prefixes minted in three unrelated files — so the rule that
 * decides whether a message may steer a running turn or must interrupt-and-queue lived in
 * a string format, enforced nowhere, and a producer that spelled its id differently
 * silently took the other branch. Stating it is the whole fix.
 *
 * - `user` — a frame from the client: the user typed or clicked.
 * - `relay` — an agent handing work to another agent (the `relay` tool, `direct_message`,
 *   `window.message`).
 * - `hook` — an app agent's answer coming back to the agent that asked for it.
 * - `notify` — a subscription or app-event wake.
 *
 * `relay` and `hook` are the two that must not be steered into a running turn: steering
 * can report success without the model ever processing the injected message, and unlike a
 * user who is watching, nothing behind these will ask again. They interrupt and queue.
 */
export type TaskKind = 'user' | 'relay' | 'hook' | 'notify';

/**
 * A task to be processed by the pool.
 */
export interface Task {
  /**
   * The tier the *producer* asked for — a request, not the routing key.
   *
   * `ContextPool.handleTask` re-derives the real executor from the task's window
   * (windowId → appId), so a `'app'` task naming a plain window runs on the monitor agent
   * and an `'app'` task naming a preview window does too. `'session'` is honored by
   * `handleSessionTask` alone and never reaches `handleTask` at all. The name says
   * "requested" so that reading it as the answer is not the easy mistake.
   */
  requestedType: 'monitor' | 'app' | 'session';
  /** Who produced this task. See {@link TaskKind}. */
  kind: TaskKind;
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
 * What running one agent turn needs, and nothing else.
 *
 * Every task processor used to receive the entire pool — the agent registry, all six
 * policies, the timelines, the mutable `savedThreadIds` — so none of them could be reasoned
 * about on its own: reading `AppTaskProcessor` told you nothing about whether it touched a
 * monitor's queue, because it could. The tiers below narrow that to what each one actually
 * reaches for, and `turn-helpers.ts` — the machinery all of them share — sees only this.
 *
 * `ContextPool` still implements the union ({@link PoolContext}); the narrowing is about
 * what a processor can *see*, not about handing it a different object.
 */
export interface TurnContext {
  readonly contextTape: ContextTape;
  readonly windowState: WindowStateRegistry;
  readonly sharedLogger: SessionLogger | null;
  readonly providerType: ProviderType | null;
  readonly contextAssembly: ContextAssemblyPolicy;
  readonly reloadPolicy: ReloadCachePolicy;
  sendEvent(event: ServerEvent): Promise<void>;
}

/**
 * The interaction timeline of one monitor. There is no session-wide timeline: an entry is
 * drained into the next turn of the desktop it happened on, and no other.
 */
export interface TimelineAccess {
  timelineFor(monitorId: string): InteractionTimeline;
}

/** What `MonitorTaskProcessor` needs: the monitor queues, the background budget, threads. */
export interface MonitorPoolContext extends TurnContext, TimelineAccess {
  readonly agentPool: AgentPool;
  readonly budgetPolicy: MonitorBudgetPolicy;
  savedThreadIds?: Record<string, string>;
  getOrCreateMonitorQueue(monitorId: string): MonitorQueuePolicy;
}

/** What `AppTaskProcessor` needs: the window queues, and the hook that answers a monitor. */
export interface AppPoolContext extends TurnContext, TimelineAccess {
  readonly sessionId: SessionId;
  readonly agentPool: AgentPool;
  readonly windowQueuePolicy: WindowQueuePolicy;
  /** Deliver a hook-triggered response notification to the monitor agent. */
  notifyHookResponse(
    appId: string,
    windowId: string,
    monitorId: string,
    responseText: string,
  ): void;
}

/**
 * What `SessionTaskProcessor` needs — the smallest of the three. The deputy has no queue
 * and no budget: it is one agent, running one turn at a time, on the user's own behalf.
 */
export interface SessionPoolContext extends TurnContext {
  readonly agentPool: AgentPool;
}

/**
 * What `WindowEventCoordinator` needs. Notably not a {@link TurnContext}: it runs no turns
 * — it routes notifications back through the pool's one task door and tears down window
 * state, so it never assembles a prompt or sends a turn event.
 */
export interface WindowEventPoolContext extends TimelineAccess {
  readonly agentPool: AgentPool;
  readonly contextTape: ContextTape;
  readonly windowState: WindowStateRegistry;
  readonly windowSubscriptionPolicy: WindowSubscriptionPolicy;
}

/**
 * Everything the pool offers its collaborators — implemented by `ContextPool`, and the
 * union of the four tiers above. Nothing should depend on *this*; depend on the tier.
 */
export interface PoolContext
  extends MonitorPoolContext, AppPoolContext, SessionPoolContext, WindowEventPoolContext {}
