/**
 * Shared types and interface for ContextPool processors.
 *
 * - `Task` — moved here to break circular imports between context-pool <-> policies.
 * - `PoolContext` — the contract that MonitorTaskProcessor and AppTaskProcessor depend on.
 */

import type { ServerEvent, UserInteraction } from '@yaar/shared';
import type { ContextTape } from './context.js';
import type { AgentPool } from './agent-pool.js';
import type { InteractionTimeline } from './interaction-timeline.js';
import type { WindowStateRegistry } from '../session/window-state.js';
import type { SessionLogger } from '../logging/index.js';
import type { ProviderType } from '../providers/types.js';
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
  type: 'monitor' | 'app';
  messageId: string;
  windowId?: string;
  content: string;
  interactions?: UserInteraction[];
  actionId?: string; // For parallel button actions
  monitorId?: string; // Which monitor this task belongs to
  /** One-shot hook: notify the originating agent when this task completes. */
  hook?: 'response';
}

/**
 * The contract processors depend on — implemented by ContextPool.
 */
export interface PoolContext {
  readonly agentPool: AgentPool;
  readonly contextTape: ContextTape;
  readonly timeline: InteractionTimeline;
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
  sendEvent(event: ServerEvent): Promise<void>;
  /** Deliver a hook-triggered response notification to the monitor agent. */
  notifyHookResponse(
    appId: string,
    windowId: string,
    monitorId: string,
    responseText: string,
  ): void;
}
