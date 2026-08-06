/**
 * ContextPool - Unified task orchestration facade.
 *
 * Routes tasks to agents via AgentPool:
 * - Monitor tasks: monitor agent (idle) or ephemeral agent (busy) — sequential queue
 * - App tasks: persistent per-app agents for app protocol windows
 * - Plain window tasks: routed to the main agent with full conversation context
 * - InteractionTimeline: user interactions and agent actions accumulated, drained on monitor agent's next turn
 * - ContextTape: kept for logging/debugging
 *
 * Processing logic is delegated to:
 * - MonitorTaskProcessor: main queue, ephemeral overflow, budget enforcement
 * - AppTaskProcessor: app agent lifecycle and task execution
 * Complex work is delegated to native provider subagents (Claude Task / Codex collab)
 */

import { ContextTape, type ContextMessage } from './context.js';
import { getMonitorTurnOptions } from './profiles/index.js';
import { monitorRole } from './roles.js';
import { AgentPool, type PooledAgent, type AgentEntry } from './agent-pool.js';
import type { AgentSession } from './agent-session.js';
import { InteractionTimeline } from './interaction-timeline.js';
import {
  ServerEventType,
  isPreviewAppId,
  type ServerEvent,
  type UserInteraction,
} from '@yaar/shared';
import type { AITransport, ProviderType } from '../providers/types.js';
import { createSession, SessionLogger } from '../logging/index.js';
import type { SessionId } from '../session/types.js';
import { getAgentLimiter } from './limiter.js';
import { genId } from '../lib/ids.js';
import { acquireWarmProvider, getWarmPool } from '../providers/factory.js';
import type { WindowStateRegistry } from '../session/window-state.js';
import type { ReloadCache } from '../reload/cache.js';
import {
  MonitorQueuePolicy,
  WindowQueuePolicy,
  ContextAssemblyPolicy,
  ReloadCachePolicy,
  MonitorBudgetPolicy,
  WindowSubscriptionPolicy,
} from './context-pool-policies/index.js';
import type { WindowChangeEvent } from './context-pool-policies/index.js';
import { MonitorTaskProcessor } from './monitor-task-processor.js';
import { AppTaskProcessor, appProcessingKey } from './app-task-processor.js';
import { SessionTaskProcessor } from './session-task-processor.js';
import { WindowEventCoordinator } from './window-event-coordinator.js';
import type { PoolContext, PoolStats, Task } from './pool-types.js';

import { MAX_QUEUE_SIZE } from '../config.js';

// Re-export Task for barrel compatibility
export type { Task } from './pool-types.js';

/** Implements PoolContext so processors can access shared state and policies. */
export class ContextPool implements PoolContext {
  /** This session's key in the SessionHub — distinct from `logSessionId` below. */
  readonly sessionId: SessionId;
  /** The session_logs/ directory name. Names a transcript on disk, not a live session. */
  private logSessionId: string | null = null;

  readonly agentPool: AgentPool;
  readonly contextTape: ContextTape;
  readonly windowState: WindowStateRegistry;
  readonly contextAssembly = new ContextAssemblyPolicy();
  readonly reloadPolicy: ReloadCachePolicy;
  readonly windowQueuePolicy = new WindowQueuePolicy();
  readonly budgetPolicy = new MonitorBudgetPolicy();
  readonly windowSubscriptionPolicy = new WindowSubscriptionPolicy();
  sharedLogger: SessionLogger | null = null;
  savedThreadIds?: Record<string, string>;
  providerType: ProviderType | null = null;

  private broadcastFn: (event: ServerEvent) => void;
  private monitorQueues = new Map<string, MonitorQueuePolicy>();
  /**
   * One timeline per monitor — what happened on a desktop is drained into that
   * desktop's next turn and no other's.
   *
   * A single session-wide timeline made every entry belong to whichever monitor spoke
   * next: monitor 1's agent read (and drained) the windows the user moved on monitor 0,
   * and monitor 0 never saw them at all.
   */
  private timelines = new Map<string, InteractionTimeline>();
  private resetting = false;
  private inflightCount = 0;
  private inflightResolve: (() => void) | null = null;

  private monitorProcessor: MonitorTaskProcessor;
  private appProcessor: AppTaskProcessor;
  private sessionProcessor: SessionTaskProcessor;
  private windowEvents: WindowEventCoordinator;

  /**
   * Where this pool gets its providers. Defaults to the global warm pool; the loopback
   * harness injects a scripted transport here instead of stubbing the factory module
   * process-wide. See `AgentPool.acquireProvider`.
   */
  private readonly acquireProvider: () => Promise<AITransport | null>;

  constructor(
    sessionId: SessionId,
    windowState: WindowStateRegistry,
    reloadCache: ReloadCache,
    broadcast: (event: ServerEvent) => void,
    restoredContext: ContextMessage[] = [],
    savedThreadIds?: Record<string, string>,
    acquireProvider?: () => Promise<AITransport | null>,
  ) {
    this.sessionId = sessionId;
    this.broadcastFn = broadcast;
    this.acquireProvider = acquireProvider ?? acquireWarmProvider;
    this.windowState = windowState;
    this.reloadPolicy = new ReloadCachePolicy(reloadCache);
    this.savedThreadIds = savedThreadIds;
    this.contextTape = new ContextTape();
    if (restoredContext.length > 0) {
      this.contextTape.restore(restoredContext);
      console.log(
        `[ContextPool] Restored ${restoredContext.length} context messages from previous session`,
      );
    }
    this.agentPool = new AgentPool(
      sessionId,
      broadcast,
      (rawId, monitorId) => {
        // The lookup must be scoped to the acting monitor before we fall back to
        // registering. Raw IDs are derived from the appId, so an unscoped resolve
        // would hand monitor 1's agent the handle of monitor 0's window of the same
        // app — its window.create would land on monitor 0's window and every message
        // after it would drive monitor 0's app agent instead of its own.
        if (monitorId) {
          const existing = windowState.handleMap.resolve(rawId, monitorId);
          return existing ?? windowState.handleMap.register(rawId, monitorId);
        }
        return windowState.handleMap.resolve(rawId) ?? rawId;
      },
      this.acquireProvider,
    );

    this.monitorProcessor = new MonitorTaskProcessor(this);
    this.appProcessor = new AppTaskProcessor(this);
    this.sessionProcessor = new SessionTaskProcessor(this);
    // Notifications route back through handleTask, not the processors directly, so a
    // subscription wake is subject to the same reset guard and inflight accounting as
    // any other task.
    this.windowEvents = new WindowEventCoordinator(this, this.appProcessor, (task) => {
      this.handleTask(task).catch((err) => {
        console.error('[ContextPool] Error delivering window notification:', err);
      });
    });
  }

  // ── PoolContext methods ─────────────────────────────────────────────

  /** The timeline for one monitor, created on first use. */
  timelineFor(monitorId: string): InteractionTimeline {
    let timeline = this.timelines.get(monitorId);
    if (!timeline) {
      timeline = new InteractionTimeline();
      this.timelines.set(monitorId, timeline);
    }
    return timeline;
  }

  getOrCreateMonitorQueue(monitorId: string): MonitorQueuePolicy {
    let queue = this.monitorQueues.get(monitorId);
    if (!queue) {
      queue = new MonitorQueuePolicy(MAX_QUEUE_SIZE);
      this.monitorQueues.set(monitorId, queue);
    }
    return queue;
  }

  async sendEvent(event: ServerEvent): Promise<void> {
    this.broadcastFn(event);
  }

  notifyHookResponse(
    appId: string,
    windowId: string,
    monitorId: string,
    responseText: string,
  ): void {
    const messageId = genId('hook-resp');
    this.handleTask({
      type: 'monitor',
      messageId,
      monitorId,
      content: `<agent-hook type="response" appId="${appId}" windowId="${windowId}">${responseText || '(no response text)'}</agent-hook>`,
    }).catch((err) => {
      console.error('[ContextPool] Hook response delivery failed:', err);
    });
  }

  async initialize(existingLogger?: SessionLogger): Promise<boolean> {
    const provider = await this.acquireProvider();
    if (!provider) {
      await this.sendEvent({
        type: ServerEventType.ERROR,
        error: 'No AI provider available. Install Claude CLI.',
      });
      return false;
    }

    this.providerType = provider.providerType;
    if (existingLogger) {
      this.sharedLogger = existingLogger;
      this.logSessionId = existingLogger.getSessionId();
      existingLogger.updateProvider(provider.name);
    } else {
      const sessionInfo = await createSession(provider.name);
      this.sharedLogger = new SessionLogger(sessionInfo);
      this.logSessionId = sessionInfo.sessionId;
    }
    this.agentPool.setLogger(this.sharedLogger);

    const monitorAgent = await this.agentPool.createMonitorAgent('0', provider);
    if (!monitorAgent) {
      await provider.dispose();
      return false;
    }
    this.prewarmMonitorAgent(monitorAgent, '0');

    // Send the hub id as `sessionId` — the client mints iframe tokens and rejoins the
    // WebSocket with whatever this event carries, and both are keyed by the hub. The
    // log id rides alongside for the history/restore UI, which is keyed by log dir.
    await this.sendEvent({
      type: ServerEventType.CONNECTION_STATUS,
      status: 'connected',
      provider: provider.name,
      sessionId: this.sessionId,
      logSessionId: this.logSessionId ?? undefined,
    });

    return true;
  }

  async createMonitorAgent(monitorId: string): Promise<boolean> {
    const provider = await this.acquireProvider();
    if (!provider) {
      await this.sendEvent({
        type: ServerEventType.ERROR,
        error: 'No AI provider available for new monitor.',
        monitorId,
      });
      return false;
    }

    const agent = await this.agentPool.createMonitorAgent(monitorId, provider);
    if (!agent) {
      await provider.dispose();
      await this.sendEvent({
        type: ServerEventType.ERROR,
        error: 'Agent limit reached. Cannot create new monitor.',
        monitorId,
      });
      return false;
    }

    this.prewarmMonitorAgent(agent, monitorId);
    console.log(`[ContextPool] Created monitor agent for ${monitorId}`);
    return true;
  }

  /**
   * Fire-and-forget: open the monitor agent's provider stream (process + MCP
   * connections) with the exact options its first turn will use, so the first
   * user message starts instantly instead of paying spawn + MCP handshake.
   */
  private prewarmMonitorAgent(agent: PooledAgent, monitorId: string): void {
    void agent.session.prewarm(monitorRole(monitorId), {
      monitorId,
      ...getMonitorTurnOptions(this.providerType ?? ''),
    });
  }

  hasMonitorAgent(monitorId: string): boolean {
    return this.agentPool.hasMonitorAgent(monitorId);
  }

  getMonitorAgentIds(): string[] {
    return this.agentPool.getMonitorAgentIds();
  }

  /** Every live agent, for the reconnect snapshot's "who is actually still running". */
  listAgents(): AgentEntry[] {
    return this.agentPool.listAgents();
  }

  getLogSessionId(): string | null {
    return this.logSessionId;
  }

  async removeMonitorAgent(monitorId: string): Promise<void> {
    const queue = this.monitorQueues.get(monitorId);
    if (queue) {
      this.reportDropped(
        queue.clear().map((i) => i.task),
        `monitor ${monitorId} was removed`,
      );
      this.monitorQueues.delete(monitorId);
    }
    // Nothing will ever drain this monitor's timeline again.
    this.timelines.delete(monitorId);

    // AgentPool.removeMonitorAgent disposes the monitor's app agents too; drop the
    // processor's window tracking for them so nothing dangles.
    const removed = await this.agentPool.removeMonitorAgent(monitorId);
    this.appProcessor.clearMonitor(monitorId);
    if (removed) {
      console.log(`[ContextPool] Removed monitor agent for ${monitorId}`);
    }
  }

  /** An app's files changed on disk (deploy) — rebuild its agent profile next turn. */
  invalidateAppProfile(appId: string): void {
    this.appProcessor.invalidateProfile(appId);
  }

  suspendMonitor(monitorId: string): boolean {
    if (!this.agentPool.hasMonitorAgent(monitorId)) return false;
    const queue = this.getOrCreateMonitorQueue(monitorId);
    queue.suspend();
    console.log(`[ContextPool] Suspended monitor ${monitorId}`);
    return true;
  }

  resumeMonitor(monitorId: string): boolean {
    const queue = this.monitorQueues.get(monitorId);
    if (!queue || !queue.isSuspended()) return false;
    queue.resume();
    console.log(`[ContextPool] Resumed monitor ${monitorId}`);
    this.monitorProcessor
      .processMonitorQueue(monitorId)
      .catch((err) => console.error(`[ContextPool] Error draining queue after resume:`, err));
    return true;
  }

  isMonitorSuspended(monitorId: string): boolean {
    const queue = this.monitorQueues.get(monitorId);
    return queue?.isSuspended() ?? false;
  }

  async getOrCreateSessionAgent(): Promise<PooledAgent | null> {
    return this.sessionProcessor.getOrCreateAgent();
  }

  /**
   * Process a user message routed to the **session agent** (the user's deputy).
   *
   * Wakes the lazy session-agent singleton (born on first use) and runs a turn
   * with a `session-*` role — the principal tier that unlocks `yaar://session/*`,
   * including `yaar://session/browser` (the user's real browser). Triggered by
   * the CLI-panel "Session" target toggle.
   *
   * This method is the reset/inflight guard; the turn itself is `SessionTaskProcessor`.
   */
  async handleSessionTask(task: Task): Promise<void> {
    if (this.resetting) {
      console.log(`[ContextPool] Rejecting session task ${task.messageId} — pool is resetting`);
      this.reportDropped([task], 'the agent pool is resetting');
      return;
    }

    // Validate before entering inflight: the missing-monitor throw is a routing bug
    // upstream, and it must not leave the inflight counter raised on its way out.
    if (!task.monitorId) {
      throw new Error(
        `Cannot run session task ${task.messageId}: no monitor. A user-scoped task takes ` +
          `its monitor from the connection that sent it.`,
      );
    }

    this.inflightEnter();
    try {
      await this.sessionProcessor.process(task);
    } finally {
      this.inflightExit();
    }
  }

  async disposeSessionAgent(): Promise<void> {
    await this.agentPool.disposeSessionAgent();
  }

  private inflightEnter(): void {
    this.inflightCount++;
  }

  private inflightExit(): void {
    this.inflightCount--;
    if (this.inflightCount <= 0 && this.inflightResolve) {
      this.inflightResolve();
      this.inflightResolve = null;
    }
  }

  private awaitInflight(): Promise<void> {
    if (this.inflightCount <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.inflightResolve = resolve;
    });
  }

  /**
   * Tell the client about work it asked for that will not be done.
   *
   * The rule this enforces: **any path that drops a user message emits an ERROR naming
   * that message.** Every drop site here had the id in hand and threw it away — a reset
   * cleared the queues, a monitor was removed, an app window closed — and the message
   * ceased to exist without anything on the user's screen changing. Their command had
   * simply not happened, and the only clue was a chip still reading "queued".
   */
  private reportDropped(tasks: Task[], reason: string): void {
    for (const task of tasks) {
      void this.sendEvent({
        type: ServerEventType.ERROR,
        error: `Message dropped: ${reason}.`,
        messageId: task.messageId,
        ...(task.monitorId ? { monitorId: task.monitorId } : {}),
      });
    }
  }

  async handleTask(task: Task): Promise<void> {
    if (this.resetting) {
      console.log(`[ContextPool] Rejecting task ${task.messageId} — pool is resetting`);
      this.reportDropped([task], 'the agent pool is resetting');
      return;
    }

    this.inflightEnter();
    try {
      if (task.type === 'monitor') {
        await this.monitorProcessor.queueMonitorTask(task);
      } else {
        const appId = task.windowId ? this.windowState.getAppIdForWindow(task.windowId) : undefined;
        // A preview window carries an app identity so that `self` resolves inside it, but it
        // is not the app: devtools is the agent for anything happening in a preview. Routing
        // it here would spawn a second app agent nobody asked for, and — since this is the
        // only writer of AppTaskProcessor.activeWindows — would let the preview claim the
        // active-window slot that cross-app control and direct messages resolve through.
        if (appId && task.windowId && !isPreviewAppId(appId)) {
          await this.appProcessor.handleAppTask(task, appId);
        } else {
          // Plain window → the monitor agent, on the window's OWN monitor.
          //
          // WINDOW_MESSAGE and COMPONENT_ACTION carry no monitorId — the client sends a
          // windowId, and the window is what knows where it lives, so the task's monitor
          // must be derived from the window rather than re-typed as-is.
          await this.monitorProcessor.queueMonitorTask({
            ...task,
            type: 'monitor',
            monitorId: this.monitorForWindowTask(task),
          });
        }
      }
    } finally {
      this.inflightExit();
    }
  }

  /**
   * The monitor a window-scoped task runs on: the one its window is on.
   *
   * There is no fallback. A task naming a window the registry does not know cannot be
   * placed.
   */
  private monitorForWindowTask(task: Task): string {
    const monitorId = task.windowId
      ? this.windowState.getMonitorForWindow(task.windowId)
      : undefined;
    if (!monitorId) {
      throw new Error(
        `Cannot route task ${task.messageId}: no monitor for window ${task.windowId ?? '(none)'}. ` +
          `A window-scoped task must name a window the session knows.`,
      );
    }
    return monitorId;
  }

  /** The windowId for a given agent instanceId. Checks app agents via AppTaskProcessor. */
  findWindowForAgent(agentId: string): string | undefined {
    return this.windowEvents.findWindowForAgent(agentId);
  }

  /**
   * Resolve the most recently active window for an app on a monitor (used by
   * DirectMessage and cross-app control routing). Scoped to the monitor so a
   * caller on monitor 1 can never reach into monitor 0's copy of the app.
   */
  getActiveAppWindow(monitorId: string, appId: string): string | undefined {
    return this.windowEvents.getActiveAppWindow(monitorId, appId);
  }

  recordMonitorAction(monitorId: string): void {
    this.monitorProcessor.recordMonitorAction(monitorId);
  }

  notifyWindowSubscribers(
    windowId: string,
    event: WindowChangeEvent,
    summary: string,
    sourceAgentKey?: string,
  ): void {
    this.windowEvents.notifyWindowSubscribers(windowId, event, summary, sourceAgentKey);
  }

  notifyAppChannel(
    windowId: string,
    channel: string,
    payload: unknown,
    sourceAgentKey?: string,
  ): void {
    this.windowEvents.notifyAppChannel(windowId, channel, payload, sourceAgentKey);
  }

  handleWindowClose(windowId: string, appId?: string, monitorId?: string): void {
    this.windowEvents.handleWindowClose(windowId, appId, monitorId);
  }

  /** Whether an app interaction for this window addresses a currently active app turn. */
  hasActiveAppAgentTurn(windowId: string): boolean {
    const appId = this.windowState.getAppIdForWindow(windowId);
    const monitorId = this.windowState.getMonitorForWindow(windowId);
    if (!appId || !monitorId || isPreviewAppId(appId)) return false;
    return this.windowQueuePolicy.isProcessing(appProcessingKey(monitorId, appId));
  }

  /**
   * File user interactions on the timeline of the monitor they happened on.
   *
   * The monitor is the one the interaction was stamped with (the sending tab looks at
   * exactly one), falling back to the window's owner. An interaction that names neither
   * belongs to no desktop we can identify — pushing it to all of them would put monitor
   * 0's clicks in monitor 1's prompt, which is the leak this scoping exists to close.
   */
  pushUserInteractions(interactions: UserInteraction[]): void {
    for (const interaction of interactions) {
      if (interaction.type === 'draw') continue;
      const monitorId =
        interaction.monitorId ??
        (interaction.windowId
          ? this.windowState.getMonitorForWindow(interaction.windowId)
          : undefined);
      if (!monitorId) {
        console.warn(
          `[ContextPool] Dropping "${interaction.type}" interaction — no monitor could be resolved for it.`,
        );
        continue;
      }
      this.timelineFor(monitorId).pushUser(interaction);
    }
  }

  getSessionLogger(): SessionLogger | null {
    return this.sharedLogger;
  }

  getPrimaryAgent(monitorId?: string): AgentSession | null {
    return this.agentPool.getMonitorAgentSession(monitorId);
  }

  /**
   * Stop everything: the running turns *and* the work waiting behind them.
   *
   * The queues have to go first, and they have to go at all. `processMonitorTask`
   * drains its monitor's queue on the way out, so interrupting alone only stops
   * the turn the user can see — the next queued message starts the moment that
   * turn unwinds, and a stop button that starts an agent is not a stop button.
   *
   * Dropping them is deliberately noisy (`reportDropped`): each one is a message
   * the user sent and is still waiting on, and silence would read as "sent and
   * ignored" rather than "stopped, as asked".
   *
   * This is the *user's* stop. The relay path (`MonitorTaskProcessor`) interrupts
   * an agent to make its queue drain sooner and calls `session.interrupt()`
   * directly, which is why that meaning of "interrupt" does not pass through
   * here and keeps its queue.
   */
  async interruptAll(): Promise<void> {
    const dropped: Task[] = [];
    this.monitorQueues.forEach((q) => dropped.push(...q.clear().map((i) => i.task)));
    dropped.push(...this.windowQueuePolicy.clear().map((i) => i.task));
    this.reportDropped(dropped, 'the agents were stopped');
    await this.agentPool.interruptAll();
  }

  async interruptAgent(agentId: string): Promise<boolean> {
    return this.agentPool.interruptByIdOrRole(agentId);
  }

  hasAgent(agentId: string): boolean {
    return this.agentPool.hasAgent(agentId);
  }

  getStats(): PoolStats {
    const poolStats = this.agentPool.getStats();
    const windowQueueSizes = this.windowQueuePolicy.getQueueSizes();
    return {
      ...poolStats,
      monitorQueueSize: Array.from(this.monitorQueues.values()).reduce(
        (sum, q) => sum + q.size(),
        0,
      ),
      windowQueueSizes,
      contextTapeSize: this.contextTape.length,
      timelineSize: Array.from(this.timelines.values()).reduce((sum, t) => sum + t.size, 0),
      monitorBudget: this.budgetPolicy.getStats(),
    };
  }

  /** Shared teardown logic used by both reset() and cleanup(). */
  private async teardown(options?: { closeWindows?: boolean }): Promise<void> {
    const closeWindows = options?.closeWindows ?? true;
    // 1. Clear queues so no new tasks start from dequeue. Everything in them is a message
    //    the user sent and is still waiting on; say that it is not coming.
    const dropped: Task[] = [];
    this.monitorQueues.forEach((q) => dropped.push(...q.clear().map((i) => i.task)));
    this.monitorQueues.clear();
    dropped.push(...this.windowQueuePolicy.clear().map((i) => i.task));
    this.reportDropped(dropped, 'the agent pool was reset');

    // 2. Reject blocked limiter/budget waiters so they unblock and exit
    getAgentLimiter().clearWaiting(new Error('Pool resetting'));
    this.budgetPolicy.clearWaiting(new Error('Pool resetting'));

    // 3. Interrupt running queries so handleMessage loops exit
    try {
      await this.agentPool.interruptAll();
    } catch (err) {
      console.error('[ContextPool] Teardown: interruptAll failed:', err);
    }

    // 4. Wait for all in-flight task functions to return (with timeout)
    try {
      await Promise.race([
        this.awaitInflight(),
        new Promise<void>((resolve) => setTimeout(resolve, 30_000)),
      ]);
    } catch (err) {
      console.error('[ContextPool] Teardown: awaitInflight failed:', err);
    }

    // 5. Now safe to dispose agents (no in-flight references)
    try {
      await this.agentPool.cleanup();
    } catch (err) {
      console.error('[ContextPool] Teardown: agentPool.cleanup failed:', err);
    }

    // 6. Close all tracked windows on the frontend (skip during reset — frontend preserves windows)
    if (closeWindows) {
      const openWindows = this.windowState.listWindows();
      if (openWindows.length > 0) {
        const closeActions = openWindows.map((win) => ({
          type: 'window.close' as const,
          windowId: win.id,
        }));
        await this.sendEvent({ type: ServerEventType.ACTIONS, actions: closeActions });
      }
    }

    // 7. Clear remaining state
    this.contextTape.clear();
    this.timelines.clear();
    this.windowEvents.clear();
    this.appProcessor.disposeAll();
    if (closeWindows) {
      this.windowState.clear();
    }
    this.budgetPolicy.clear();
  }

  async reset(): Promise<void> {
    if (this.resetting) return;
    this.resetting = true;

    // Save active monitor IDs before clearing so we can recreate agents for all of them
    const activeMonitorIds = [...this.monitorQueues.keys()];
    for (const monitorId of this.agentPool.getMonitorAgentIds()) {
      if (!activeMonitorIds.includes(monitorId)) {
        activeMonitorIds.push(monitorId);
      }
    }
    if (!activeMonitorIds.includes('0')) {
      activeMonitorIds.push('0');
    }

    await this.teardown({ closeWindows: false });

    // Dispose pooled Codex providers (AppServer process stays alive)
    try {
      await getWarmPool().resetCodexProviders();
    } catch (err) {
      console.error('[ContextPool] Reset: resetCodexProviders failed:', err);
    }

    // Clear saved thread IDs so we don't resume old sessions
    this.savedThreadIds = undefined;

    // Re-create fresh main agents for ALL previously active monitors
    for (const monitorId of activeMonitorIds) {
      const provider = await this.acquireProvider();
      if (provider) {
        const agent = await this.agentPool.createMonitorAgent(monitorId, provider);
        if (agent) {
          if (monitorId === '0') {
            // Same two ids, same rule as `initialize()` above: `sessionId` is the hub key
            // the client mints iframe tokens against, `logSessionId` is the transcript dir.
            // This emitter sent the *log* id as `sessionId` — so after a reset the desktop
            // adopted a directory name (`2026-08-04_14-55-15`) as its session, and every
            // app it launched from then on held a token naming a session the hub does not
            // hold. Their session-scoped verbs (`yaar://session/agents`, `yaar://windows`,
            // `yaar://history/`) each parked the full `SessionHub.waitFor()` and answered
            // 503, so Process Explorer, Session Logs and Configurations simply never
            // loaded, while storage-only apps like devtools were unaffected.
            await this.sendEvent({
              type: ServerEventType.CONNECTION_STATUS,
              status: 'connected',
              provider: provider.name,
              sessionId: this.sessionId,
              logSessionId: this.logSessionId ?? undefined,
            });
          }
        } else {
          await provider.dispose();
          console.warn(`[ContextPool] Reset: failed to recreate agent for ${monitorId}`);
        }
      } else {
        console.warn(`[ContextPool] Reset: no provider available for ${monitorId}`);
      }
    }

    this.resetting = false;
    console.log(
      `[ContextPool] Reset complete: recreated ${activeMonitorIds.length} monitor agent(s), cleared all state`,
    );
  }

  async cleanup(): Promise<void> {
    this.resetting = true;
    await this.teardown();
    this.sharedLogger = null;
    this.resetting = false;
  }
}
