/**
 * MonitorTaskProcessor — handles monitor task execution, ephemeral overflow,
 * and monitor queue draining.
 *
 * Extracted from ContextPool to separate monitor task orchestration concerns.
 */

import { ServerEventType } from '@yaar/shared';
import type { PoolContext, Task } from './pool-types.js';
import type { PooledAgent } from './agent-pool.js';
import { getMonitorTurnOptions } from './profiles/index.js';
import { buildReloadContext, runAgentTurn, createBudgetOutputCallback } from './turn-helpers.js';
import { monitorSource } from './context.js';
import { MAX_QUEUE_SIZE } from '../config.js';

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
  constructor(private readonly ctx: PoolContext) {}

  /**
   * Route a monitor task: to the monitor agent if idle, or to an ephemeral agent.
   */
  async queueMonitorTask(task: Task): Promise<void> {
    const monitorId = monitorOf(task);

    // Acquire budget slot for background monitors (blocks until available)
    await this.ctx.budgetPolicy.acquireTaskSlot(monitorId);

    try {
      await this.queueMonitorTaskInner(task, monitorId);
    } finally {
      this.ctx.budgetPolicy.releaseTaskSlot(monitorId);
    }
  }

  /**
   * Enqueue a task, or tell the client the queue is full. Returns whether it was queued.
   *
   * `why` is the second sentence of the refusal. The plan proposed collapsing the two
   * wordings into one, but they are not the same message: "Monitor is suspended" says
   * the queue will not drain until someone resumes it, while "Please wait" says it is
   * draining already. Losing that leaves the suspended case advising the user to wait
   * for something that is not going to happen.
   */
  private async enqueueOrReject(
    queue: { canEnqueue(): boolean; enqueue(task: Task): number },
    task: Task,
    monitorId: string,
    why: string,
    queuedLog: (position: number) => string,
  ): Promise<boolean> {
    if (!queue.canEnqueue()) {
      await this.ctx.sendEvent({
        type: ServerEventType.ERROR,
        error: `Message queue is full (${MAX_QUEUE_SIZE} messages). ${why}`,
        messageId: task.messageId,
        monitorId,
      });
      return false;
    }

    const position = queue.enqueue(task);
    console.log(queuedLog(position));
    await this.ctx.sendEvent({
      type: ServerEventType.MESSAGE_QUEUED,
      messageId: task.messageId,
      position,
    });
    return true;
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
          `[ContextPool] Monitor ${monitorId} is suspended — queued task ${task.messageId}, queue size: ${position}`,
      );
      return;
    }

    if (!this.ctx.agentPool.isMonitorAgentBusy(monitorId)) {
      // Monitor agent idle → process directly
      await this.processMonitorTask(this.ctx.agentPool.getMonitorAgent(monitorId)!, task);
      return;
    }

    // Monitor agent busy → interrupt + queue for relay/hook messages so they
    // never silently evaporate (streamInput can succeed but the model may not
    // actually process the injected message).
    const isRelay = task.messageId.startsWith('relay-') || task.messageId.startsWith('hook-resp-');
    if (isRelay) {
      const queued = await this.enqueueOrReject(
        this.ctx.getOrCreateMonitorQueue(monitorId),
        task,
        monitorId,
        'Please wait for current operations to complete.',
        (position) =>
          `[ContextPool] Relay/hook arrived while monitor ${monitorId} busy — interrupting and queuing ${task.messageId} (position: ${position})`,
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
      console.log(
        `[ContextPool] Steered active turn for ${monitorId} with message ${task.messageId}`,
      );
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
        `[ContextPool] Queued monitor task ${task.messageId} for ${monitorId}, queue size: ${position}`,
    );
  }

  /**
   * Process a monitor task on the monitor agent (provider session continuity).
   * Drains callback queue before processing.
   */
  async processMonitorTask(agent: PooledAgent, task: Task): Promise<void> {
    const monitorId = monitorOf(task);
    const monitorRole = `monitor-${monitorId}-${task.messageId}`;

    agent.session.setOutputCallback(createBudgetOutputCallback(this.ctx, agent, monitorId));

    console.log(
      `[ContextPool] Processing monitor task ${task.messageId} with monitor agent ${agent.id} (monitor: ${monitorId})`,
    );

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

    const canonicalMonitor = `monitor-${monitorId}`;
    const resumeSessionId = this.ctx.savedThreadIds?.[canonicalMonitor];
    delete this.ctx.savedThreadIds?.[canonicalMonitor];

    await runAgentTurn(this.ctx, {
      agent,
      role: monitorRole,
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

    await this.processMonitorQueue(monitorId);
  }

  /**
   * Process a monitor task on an ephemeral agent (fresh provider, no context).
   * Pushes a callback when done, then disposes the agent.
   */
  async processEphemeralTask(agent: PooledAgent, task: Task): Promise<void> {
    const monitorId = monitorOf(task);
    const ephemeralRole = `ephemeral-${monitorId}-${task.messageId}`;

    agent.session.setOutputCallback(
      createBudgetOutputCallback(this.ctx, agent, monitorId, 'ephemeral agent'),
    );

    console.log(
      `[ContextPool] Processing monitor task ${task.messageId} with ephemeral agent ${agent.id}`,
    );

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
        role: ephemeralRole,
        source: monitorSource(monitorId),
        task,
        prompt,
        fp,
        monitorId,
        onAfterRun: (recordedActions) => {
          this.ctx
            .timelineFor(monitorId)
            .pushAI(ephemeralRole, task.content.slice(0, 100), recordedActions);
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
      console.warn(
        `[ContextPool] Monitor ${monitorId} exceeded action budget — interrupting agent`,
      );
      const agent = this.ctx.agentPool.getMonitorAgent(monitorId);
      if (agent?.session.isRunning()) {
        agent.session.interrupt().catch((err) => {
          console.error(`[ContextPool] Failed to interrupt agent for ${monitorId}:`, err);
        });
      }
    }
  }
}
