/**
 * MonitorTaskProcessor — handles monitor task execution, ephemeral overflow,
 * and monitor queue draining.
 *
 * Extracted from ContextPool to separate monitor task orchestration concerns.
 */

import { ServerEventType } from '@yaar/shared';
import type { MonitorPoolContext, Task } from './pool-types.js';
import type { PooledAgent } from './agent-roster.js';
import { getMonitorTurnOptions } from './profiles/index.js';
import { buildReloadContext, runAgentTurn, createBudgetOutputCallback } from './turn-helpers.js';
import { monitorSource } from './context.js';
import { monitorRole, monitorTurnRole, ephemeralRole } from './roles.js';
import { enqueueOrReject } from './queue-refusal.js';
import { MAX_QUEUE_SIZE } from '../config.js';
import { createLogger } from '../observability/log.js';

const log = createLogger('MonitorTaskProcessor');

/**
 * The monitor a task runs on. Required — a task without a monitor is a routing bug
 * upstream; it must be loud where it is made, not quietly rehomed here.
 */
function monitorOf(task: Task): string {
  if (!task.monitorId) {
    throw new Error(
      `Task ${task.messageId} has no monitor. A monitor task's monitor comes from the ` +
        `connection (user messages) or from its window (window messages) — never from a default.`,
    );
  }
  return task.monitorId;
}

export class MonitorTaskProcessor {
  constructor(private readonly ctx: MonitorPoolContext) {}

  /**
   * Route a monitor task: to the monitor agent if idle, or to an ephemeral agent.
   *
   * No budget slot is taken here. A slot is "one background monitor allowed to run a
   * query", and this method mostly does not run one — it may steer an already-running
   * turn, or simply enqueue. Held from here, a slot covered the whole queue *drain* that
   * `processMonitorTask` performs on its way out (many turns, one slot) while
   * `ContextPool.resumeMonitor` entered exactly the same drain holding **none**, so
   * `MONITOR_MAX_CONCURRENT` meant a different thing depending on which door the work came
   * in by. It is taken around each turn instead — see {@link withBudgetSlot}.
   */
  async queueMonitorTask(task: Task): Promise<void> {
    await this.queueMonitorTaskInner(task, monitorOf(task));
  }

  /**
   * Run one background monitor's turn against its concurrency budget.
   *
   * Wraps a *turn*, never a drain: `processMonitorTask` re-enters `processMonitorQueue`
   * when its turn finishes, so a slot held across that would be held while the next turn
   * asks for one of its own — with `MONITOR_MAX_CONCURRENT` background monitors draining,
   * that is a deadlock against a semaphore each of them is waiting on and holding.
   * The primary monitor is never throttled, so this is a straight pass-through for it.
   */
  private async withBudgetSlot(monitorId: string, run: () => Promise<void>): Promise<void> {
    await this.ctx.budgetPolicy.acquireTaskSlot(monitorId);
    try {
      await run();
    } finally {
      this.ctx.budgetPolicy.releaseTaskSlot(monitorId);
    }
  }

  /**
   * Enqueue a monitor task, or tell the client the queue is full.
   *
   * The mechanism is shared with the window queue (`agents/queue-refusal.ts`); `why` — the
   * refusal's second sentence — deliberately is not. See that module's header.
   */
  private enqueueOrReject(
    queue: { canEnqueue(): boolean; enqueue(task: Task): number },
    task: Task,
    monitorId: string,
    why: string,
    onQueued: (position: number) => void,
  ): Promise<boolean> {
    return enqueueOrReject({
      sendEvent: (event) => this.ctx.sendEvent(event),
      queue: { canEnqueue: () => queue.canEnqueue(), enqueue: () => queue.enqueue(task) },
      task,
      monitorId,
      maxQueueSize: MAX_QUEUE_SIZE,
      why,
      onQueued,
    });
  }

  private async queueMonitorTaskInner(task: Task, monitorId: string): Promise<void> {
    // If monitor is suspended, just enqueue without attempting to process
    const suspendQueue = this.ctx.getOrCreateMonitorQueue(monitorId);
    if (suspendQueue.isSuspended()) {
      await this.enqueueOrReject(
        suspendQueue,
        task,
        monitorId,
        'Monitor is suspended.',
        (position) =>
          log.info('monitor suspended — task queued', {
            monitorId,
            messageId: task.messageId,
            position,
          }),
      );
      return;
    }

    if (!this.ctx.agentPool.isMonitorAgentBusy(monitorId)) {
      // Monitor agent idle → process directly
      await this.processMonitorTask(this.ctx.agentPool.getMonitorAgent(monitorId)!, task);
      return;
    }

    // Monitor agent busy → interrupt + queue for agent-to-agent traffic (a relay, or an
    // app agent's answer coming back) so it never silently evaporates: `streamInput` can
    // succeed while the model never actually processes the injected message, and unlike a
    // user, nothing behind these will notice and ask again.
    //
    // This used to be decided by sniffing `task.messageId` for `relay-`/`hook-resp-`
    // prefixes minted in three unrelated files. `Task.kind` says it instead.
    if (task.kind === 'relay' || task.kind === 'hook') {
      const queued = await this.enqueueOrReject(
        this.ctx.getOrCreateMonitorQueue(monitorId),
        task,
        monitorId,
        'Please wait for current operations to complete.',
        (position) =>
          log.info('relay/hook arrived while monitor busy — interrupting and queuing', {
            monitorId,
            messageId: task.messageId,
            position,
          }),
      );
      if (!queued) return;

      // Interrupt the running turn so processMonitorQueue drains immediately after.
      // This used to sit between the enqueue and the MESSAGE_QUEUED event; it is
      // ordered after now, which only changes when the client hears about a task
      // that is already on the queue either way.
      const agent = this.ctx.agentPool.getMonitorAgent(monitorId);
      if (agent?.session.isRunning()) {
        await agent.session.interrupt();
      }
      return;
    }

    // Non-relay: try to steer the active turn (Codex mid-turn injection)
    const steered = await this.ctx.agentPool.steerMonitorAgent(monitorId, task.content);
    if (steered) {
      log.info('steered active turn', { monitorId, messageId: task.messageId });
      this.ctx.contextAssembly.appendUserMessage(
        this.ctx.contextTape,
        task.content,
        monitorSource(monitorId),
      );
      const agent = this.ctx.agentPool.getMonitorAgent(monitorId)!;
      await this.ctx.sendEvent({
        type: ServerEventType.MESSAGE_ACCEPTED,
        messageId: task.messageId,
        agentId: agent.currentRole!,
      });
      return;
    }

    // Steer not supported or failed → try ephemeral
    const ephemeral = await this.ctx.agentPool.createEphemeral();
    if (ephemeral) {
      await this.processEphemeralTask(ephemeral, task);
      return;
    }

    // No agents available → queue
    await this.enqueueOrReject(
      this.ctx.getOrCreateMonitorQueue(monitorId),
      task,
      monitorId,
      'Please wait for current operations to complete.',
      (position) =>
        log.info('queued monitor task', { monitorId, messageId: task.messageId, position }),
    );
  }

  /**
   * Process a monitor task on the monitor agent (provider session continuity), then drain
   * whatever queued behind it.
   *
   * The turn holds a budget slot; the drain does not, and each turn it starts takes its own.
   */
  async processMonitorTask(agent: PooledAgent, task: Task): Promise<void> {
    const monitorId = monitorOf(task);
    await this.withBudgetSlot(monitorId, () => this.runMonitorTurn(agent, task, monitorId));
    await this.processMonitorQueue(monitorId);
  }

  private async runMonitorTurn(agent: PooledAgent, task: Task, monitorId: string): Promise<void> {
    const turnRole = monitorTurnRole(monitorId, task.messageId);

    agent.session.setOutputCallback(createBudgetOutputCallback(this.ctx, agent, monitorId));

    log.info('processing monitor task', { messageId: task.messageId, agent: agent.id, monitorId });

    const { openWindowsContext, fp, reloadPrefix } = buildReloadContext(this.ctx, task);
    const monitorContext = this.ctx.contextAssembly.buildMonitorPrompt(task.content, {
      interactions: task.interactions,
      openWindows: openWindowsContext,
      reloadPrefix,
      timeline: this.ctx.timelineFor(monitorId),
    });
    this.ctx.contextAssembly.appendUserMessage(
      this.ctx.contextTape,
      monitorContext.contextContent,
      monitorSource(monitorId),
    );

    const canonicalMonitor = monitorRole(monitorId);
    const resumeSessionId = this.ctx.savedThreadIds?.[canonicalMonitor];
    delete this.ctx.savedThreadIds?.[canonicalMonitor];

    await runAgentTurn(this.ctx, {
      agent,
      role: turnRole,
      source: monitorSource(monitorId),
      task,
      prompt: monitorContext.prompt,
      fp,
      canonicalAgent: canonicalMonitor,
      resumeSessionId,
      monitorId,
      ...getMonitorTurnOptions(this.ctx.providerType ?? ''),
      onFinally: () => {
        agent.session.setOutputCallback(null);
      },
    });
  }

  /**
   * Process a monitor task on an ephemeral agent (fresh provider, no context).
   * Pushes a callback when done, then disposes the agent.
   */
  async processEphemeralTask(agent: PooledAgent, task: Task): Promise<void> {
    const monitorId = monitorOf(task);
    // An ephemeral agent consumes a provider exactly as the monitor agent does, so it
    // is billed the same slot — this is the one turn that used to be covered only
    // incidentally, by the slot `queueMonitorTask` happened to be holding.
    await this.withBudgetSlot(monitorId, () => this.runEphemeralTurn(agent, task, monitorId));
  }

  private async runEphemeralTurn(agent: PooledAgent, task: Task, monitorId: string): Promise<void> {
    const turnRole = ephemeralRole(monitorId, task.messageId);

    agent.session.setOutputCallback(
      createBudgetOutputCallback(this.ctx, agent, monitorId, 'ephemeral agent'),
    );

    log.info('processing monitor task on ephemeral agent', {
      messageId: task.messageId,
      agent: agent.id,
      monitorId,
    });

    const { openWindowsContext, fp, reloadPrefix } = buildReloadContext(this.ctx, task);
    const prompt = openWindowsContext + reloadPrefix + task.content;
    this.ctx.contextAssembly.appendUserMessage(
      this.ctx.contextTape,
      task.content,
      monitorSource(monitorId),
    );

    try {
      await runAgentTurn(this.ctx, {
        agent,
        role: turnRole,
        source: monitorSource(monitorId),
        task,
        prompt,
        fp,
        monitorId,
        onAfterRun: (recordedActions) => {
          this.ctx
            .timelineFor(monitorId)
            .pushAI(turnRole, task.content.slice(0, 100), recordedActions);
        },
        onFinally: () => {
          agent.session.setOutputCallback(null);
        },
      });
    } finally {
      await this.ctx.agentPool.disposeEphemeral(agent);
    }
  }

  /**
   * Process queued monitor tasks when the monitor agent becomes available.
   */
  async processMonitorQueue(monitorId = '0'): Promise<void> {
    const queue = this.ctx.getOrCreateMonitorQueue(monitorId);
    if (!queue.beginProcessing()) return;
    try {
      while (queue.size() > 0) {
        if (this.ctx.agentPool.isMonitorAgentBusy(monitorId)) break;

        const next = queue.dequeue();
        if (next)
          await this.processMonitorTask(this.ctx.agentPool.getMonitorAgent(monitorId)!, next.task);
      }
    } finally {
      queue.endProcessing();
    }
  }

  /**
   * Record an OS action against a monitor's budget.
   * Interrupts the monitor's agent if the action budget is exceeded.
   */
  recordMonitorAction(monitorId: string): void {
    this.ctx.budgetPolicy.recordAction(monitorId);
    if (!this.ctx.budgetPolicy.checkActionBudget(monitorId)) {
      log.warn('monitor exceeded action budget — interrupting agent', { monitorId });
      const agent = this.ctx.agentPool.getMonitorAgent(monitorId);
      if (agent?.session.isRunning()) {
        agent.session.interrupt().catch((err) => {
          log.error('failed to interrupt agent', { monitorId, err });
        });
      }
    }
  }
}
