/**
 * MainTaskProcessor — handles main task execution, ephemeral overflow,
 * and main queue draining.
 *
 * Extracted from ContextPool to separate main task orchestration concerns.
 */

import { ServerEventType } from '@yaar/shared';
import type { PoolContext, Task } from './pool-types.js';
import type { PooledAgent } from './agent-pool.js';
import { getDeveloperAllowedTools } from './profiles.js';
import { buildReloadContext, runAgentTurn, createBudgetOutputCallback } from './turn-helpers.js';
import { mainSource } from './context.js';

const MAX_QUEUE_SIZE = 10;

export class MainTaskProcessor {
  constructor(private readonly ctx: PoolContext) {}

  /**
   * Route a main task: to the main agent if idle, or to an ephemeral agent.
   */
  async queueMainTask(task: Task): Promise<void> {
    const monitorId = task.monitorId ?? '0';

    // Acquire budget slot for background monitors (blocks until available)
    await this.ctx.budgetPolicy.acquireTaskSlot(monitorId);

    try {
      await this.queueMainTaskInner(task, monitorId);
    } finally {
      this.ctx.budgetPolicy.releaseTaskSlot(monitorId);
    }
  }

  private async queueMainTaskInner(task: Task, monitorId: string): Promise<void> {
    if (!this.ctx.agentPool.isMainAgentBusy(monitorId)) {
      // Main agent idle → process directly
      await this.processMainTask(this.ctx.agentPool.getMainAgent(monitorId)!, task);
      return;
    }

    // Main agent busy → try to steer the active turn (Codex mid-turn injection)
    const steered = await this.ctx.agentPool.steerMainAgent(monitorId, task.content);
    if (steered) {
      console.log(
        `[ContextPool] Steered active turn for ${monitorId} with message ${task.messageId}`,
      );
      this.ctx.contextAssembly.appendUserMessage(
        this.ctx.contextTape,
        task.content,
        mainSource(monitorId),
      );
      const agent = this.ctx.agentPool.getMainAgent(monitorId)!;
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
    const queue = this.ctx.getOrCreateMainQueue(monitorId);
    if (!queue.canEnqueue()) {
      await this.ctx.sendEvent({
        type: ServerEventType.ERROR,
        error: `Message queue is full (${MAX_QUEUE_SIZE} messages). Please wait for current operations to complete.`,
      });
      return;
    }

    const position = queue.enqueue(task);
    console.log(
      `[ContextPool] Queued main task ${task.messageId} for ${monitorId}, queue size: ${position}`,
    );

    await this.ctx.sendEvent({
      type: ServerEventType.MESSAGE_QUEUED,
      messageId: task.messageId,
      position,
    });
  }

  /**
   * Process a main task on the main agent (provider session continuity).
   * Drains callback queue before processing.
   */
  async processMainTask(agent: PooledAgent, task: Task): Promise<void> {
    const monitorId = task.monitorId ?? '0';
    const mainRole = `main-${monitorId}-${task.messageId}`;

    agent.session.setOutputCallback(createBudgetOutputCallback(this.ctx, agent, monitorId));

    console.log(
      `[ContextPool] Processing main task ${task.messageId} with main agent ${agent.id} (monitor: ${monitorId})`,
    );

    const { openWindowsContext, fp, reloadPrefix } = buildReloadContext(this.ctx, task);
    const mainContext = this.ctx.contextAssembly.buildMainPrompt(task.content, {
      interactions: task.interactions,
      openWindows: openWindowsContext,
      reloadPrefix,
      timeline: this.ctx.timeline,
    });
    this.ctx.contextAssembly.appendUserMessage(
      this.ctx.contextTape,
      mainContext.contextContent,
      mainSource(monitorId),
    );

    const canonicalMain = `main-${monitorId}`;
    const resumeSessionId = this.ctx.savedThreadIds?.[canonicalMain];
    delete this.ctx.savedThreadIds?.[canonicalMain];

    await runAgentTurn(this.ctx, {
      agent,
      role: mainRole,
      source: mainSource(monitorId),
      task,
      prompt: mainContext.prompt,
      fp,
      canonicalAgent: canonicalMain,
      resumeSessionId,
      monitorId,
      allowedTools: this.ctx.providerType === 'codex' ? undefined : getDeveloperAllowedTools(),
      onFinally: () => {
        agent.session.setOutputCallback(null);
      },
    });

    await this.processMainQueue(monitorId);
  }

  /**
   * Process a main task on an ephemeral agent (fresh provider, no context).
   * Pushes a callback when done, then disposes the agent.
   */
  async processEphemeralTask(agent: PooledAgent, task: Task): Promise<void> {
    const monitorId = task.monitorId ?? '0';
    const ephemeralRole = `ephemeral-${monitorId}-${task.messageId}`;

    agent.session.setOutputCallback(
      createBudgetOutputCallback(this.ctx, agent, monitorId, 'ephemeral agent'),
    );

    console.log(
      `[ContextPool] Processing main task ${task.messageId} with ephemeral agent ${agent.id}`,
    );

    const { openWindowsContext, fp, reloadPrefix } = buildReloadContext(this.ctx, task);
    const prompt = openWindowsContext + reloadPrefix + task.content;
    this.ctx.contextAssembly.appendUserMessage(
      this.ctx.contextTape,
      task.content,
      mainSource(monitorId),
    );

    try {
      await runAgentTurn(this.ctx, {
        agent,
        role: ephemeralRole,
        source: mainSource(monitorId),
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
   * Process queued main tasks when the main agent becomes available.
   */
  async processMainQueue(monitorId = '0'): Promise<void> {
    const queue = this.ctx.getOrCreateMainQueue(monitorId);
    if (!queue.beginProcessing()) return;
    try {
      while (queue.size() > 0) {
        if (this.ctx.agentPool.isMainAgentBusy(monitorId)) break;

        const next = queue.dequeue();
        if (next)
          await this.processMainTask(this.ctx.agentPool.getMainAgent(monitorId)!, next.task);
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
      const agent = this.ctx.agentPool.getMainAgent(monitorId);
      if (agent?.session.isRunning()) {
        agent.session.interrupt().catch((err) => {
          console.error(`[ContextPool] Failed to interrupt agent for ${monitorId}:`, err);
        });
      }
    }
  }
}
