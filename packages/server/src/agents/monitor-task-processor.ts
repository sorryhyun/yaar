/**
 * MonitorTaskProcessor — handles monitor task execution, ephemeral overflow,
 * and monitor queue draining.
 *
 * Extracted from ContextPool to separate monitor task orchestration concerns.
 */

import { ServerEventType } from '@yaar/shared';
import type { PoolContext, Task } from './pool-types.js';
import type { PooledAgent } from './agent-pool.js';
import { getDeveloperAllowedTools } from './profiles/index.js';
import { buildReloadContext, runAgentTurn, createBudgetOutputCallback } from './turn-helpers.js';
import { monitorSource } from './context.js';

const MAX_QUEUE_SIZE = 10;

export class MonitorTaskProcessor {
  constructor(private readonly ctx: PoolContext) {}

  /**
   * Route a monitor task: to the monitor agent if idle, or to an ephemeral agent.
   */
  async queueMonitorTask(task: Task): Promise<void> {
    const monitorId = task.monitorId ?? '0';

    // Acquire budget slot for background monitors (blocks until available)
    await this.ctx.budgetPolicy.acquireTaskSlot(monitorId);

    try {
      await this.queueMonitorTaskInner(task, monitorId);
    } finally {
      this.ctx.budgetPolicy.releaseTaskSlot(monitorId);
    }
  }

  private async queueMonitorTaskInner(task: Task, monitorId: string): Promise<void> {
    // If monitor is suspended, just enqueue without attempting to process
    const suspendQueue = this.ctx.getOrCreateMonitorQueue(monitorId);
    if (suspendQueue.isSuspended()) {
      if (!suspendQueue.canEnqueue()) {
        await this.ctx.sendEvent({
          type: ServerEventType.ERROR,
          error: `Message queue is full (${MAX_QUEUE_SIZE} messages). Monitor is suspended.`,
        });
        return;
      }
      const position = suspendQueue.enqueue(task);
      console.log(
        `[ContextPool] Monitor ${monitorId} is suspended — queued task ${task.messageId}, queue size: ${position}`,
      );
      await this.ctx.sendEvent({
        type: ServerEventType.MESSAGE_QUEUED,
        messageId: task.messageId,
        position,
      });
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
      const queue = this.ctx.getOrCreateMonitorQueue(monitorId);
      if (!queue.canEnqueue()) {
        await this.ctx.sendEvent({
          type: ServerEventType.ERROR,
          error: `Message queue is full (${MAX_QUEUE_SIZE} messages). Please wait for current operations to complete.`,
        });
        return;
      }

      const position = queue.enqueue(task);
      console.log(
        `[ContextPool] Relay/hook arrived while monitor ${monitorId} busy — interrupting and queuing ${task.messageId} (position: ${position})`,
      );

      // Interrupt the running turn so processMonitorQueue drains immediately after
      const agent = this.ctx.agentPool.getMonitorAgent(monitorId);
      if (agent?.session.isRunning()) {
        await agent.session.interrupt();
      }

      await this.ctx.sendEvent({
        type: ServerEventType.MESSAGE_QUEUED,
        messageId: task.messageId,
        position,
      });
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
    const queue = this.ctx.getOrCreateMonitorQueue(monitorId);
    if (!queue.canEnqueue()) {
      await this.ctx.sendEvent({
        type: ServerEventType.ERROR,
        error: `Message queue is full (${MAX_QUEUE_SIZE} messages). Please wait for current operations to complete.`,
      });
      return;
    }

    const position = queue.enqueue(task);
    console.log(
      `[ContextPool] Queued monitor task ${task.messageId} for ${monitorId}, queue size: ${position}`,
    );

    await this.ctx.sendEvent({
      type: ServerEventType.MESSAGE_QUEUED,
      messageId: task.messageId,
      position,
    });
  }

  /**
   * Process a monitor task on the monitor agent (provider session continuity).
   * Drains callback queue before processing.
   */
  async processMonitorTask(agent: PooledAgent, task: Task): Promise<void> {
    const monitorId = task.monitorId ?? '0';
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
      timeline: this.ctx.timeline,
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
      allowedTools: this.ctx.providerType === 'codex' ? undefined : getDeveloperAllowedTools(),
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
    const monitorId = task.monitorId ?? '0';
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
          this.ctx.timeline.pushAI(ephemeralRole, task.content.slice(0, 100), recordedActions);
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
