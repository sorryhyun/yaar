/**
 * MainTaskProcessor — handles main task execution, ephemeral overflow,
 * and main queue draining.
 *
 * Extracted from ContextPool to separate main task orchestration concerns.
 */

import { ServerEventType } from '@yaar/shared';
import type { PoolContext, Task } from './pool-context.js';
import type { PooledAgent } from './agent-pool.js';
import { ORCHESTRATOR_PROFILE } from './profiles.js';

const MAX_QUEUE_SIZE = 10;

export class MainTaskProcessor {
  constructor(private readonly ctx: PoolContext) {}

  /**
   * Route a main task: to the main agent if idle, or to an ephemeral agent.
   */
  async queueMainTask(task: Task): Promise<void> {
    const monitorId = task.monitorId ?? 'monitor-0';

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
      this.ctx.contextAssembly.appendUserMessage(this.ctx.contextTape, task.content, 'main');
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
    const monitorId = task.monitorId ?? 'monitor-0';
    const mainRole = `main-${monitorId}-${task.messageId}`;
    agent.currentRole = mainRole;
    agent.lastUsed = Date.now();

    // Set output tracking callback for budget policy with output budget enforcement
    agent.session.setOutputCallback((bytes) => {
      this.ctx.budgetPolicy.recordOutput(monitorId, bytes);
      if (!this.ctx.budgetPolicy.checkOutputBudget(monitorId)) {
        console.warn(
          `[ContextPool] Monitor ${monitorId} exceeded output budget — interrupting agent`,
        );
        agent.session.interrupt().catch((err) => {
          console.error(`[ContextPool] Failed to interrupt agent for ${monitorId}:`, err);
        });
      }
    });

    await this.ctx.sendEvent({
      type: ServerEventType.MESSAGE_ACCEPTED,
      messageId: task.messageId,
      agentId: mainRole,
    });

    console.log(
      `[ContextPool] Processing main task ${task.messageId} with main agent ${agent.id} (monitor: ${monitorId})`,
    );

    // Build prompt with callback injection
    const windowSnapshot = this.ctx.windowState.listWindows();
    const openWindowsContext = this.ctx.contextAssembly.formatOpenWindows(
      windowSnapshot.map((w) => w.id),
    );
    const fp = this.ctx.reloadPolicy.buildFingerprint(task, windowSnapshot);
    const reloadPrefix = this.ctx.reloadPolicy.formatReloadOptions(
      this.ctx.reloadPolicy.findMatches(fp, 3),
    );
    const mainContext = this.ctx.contextAssembly.buildMainPrompt(task.content, {
      interactions: task.interactions,
      openWindows: openWindowsContext,
      reloadPrefix,
      timeline: this.ctx.timeline,
    });
    this.ctx.contextAssembly.appendUserMessage(
      this.ctx.contextTape,
      mainContext.contextContent,
      'main',
    );

    const canonicalMain = `main-${monitorId}`;
    const resumeSessionId = this.ctx.savedThreadIds?.[canonicalMain];
    delete this.ctx.savedThreadIds?.[canonicalMain];

    await agent.session.handleMessage(mainContext.prompt, {
      role: agent.currentRole!,
      source: 'main',
      interactions: task.interactions,
      messageId: task.messageId,
      canonicalAgent: canonicalMain,
      resumeSessionId,
      monitorId,
      allowedTools:
        this.ctx.providerType === 'codex' ? undefined : ORCHESTRATOR_PROFILE.allowedTools,
      onContextMessage: (role, content) => {
        if (role === 'assistant') {
          this.ctx.contextAssembly.appendAssistantMessage(this.ctx.contextTape, content, 'main');
        }
      },
    });

    // Record actions for future cache hits
    const recordedActions = agent.session.getRecordedActions();
    this.ctx.reloadPolicy.maybeRecord(task, fp, recordedActions);

    agent.session.setOutputCallback(null);
    agent.currentRole = null;
    await this.processMainQueue(monitorId);
  }

  /**
   * Process a main task on an ephemeral agent (fresh provider, no context).
   * Pushes a callback when done, then disposes the agent.
   */
  async processEphemeralTask(agent: PooledAgent, task: Task): Promise<void> {
    const monitorId = task.monitorId ?? 'monitor-0';
    const ephemeralRole = `ephemeral-${monitorId}-${task.messageId}`;
    agent.currentRole = ephemeralRole;
    agent.lastUsed = Date.now();

    // Set output tracking callback for budget policy with output budget enforcement
    agent.session.setOutputCallback((bytes) => {
      this.ctx.budgetPolicy.recordOutput(monitorId, bytes);
      if (!this.ctx.budgetPolicy.checkOutputBudget(monitorId)) {
        console.warn(
          `[ContextPool] Monitor ${monitorId} exceeded output budget — interrupting ephemeral agent`,
        );
        agent.session.interrupt().catch((err) => {
          console.error(`[ContextPool] Failed to interrupt ephemeral agent for ${monitorId}:`, err);
        });
      }
    });

    await this.ctx.sendEvent({
      type: ServerEventType.MESSAGE_ACCEPTED,
      messageId: task.messageId,
      agentId: ephemeralRole,
    });

    console.log(
      `[ContextPool] Processing main task ${task.messageId} with ephemeral agent ${agent.id}`,
    );

    // Ephemeral agents get open windows + reload options + content, but NO callback prefix and NO conversation history
    const windowSnapshot = this.ctx.windowState.listWindows();
    const openWindowsContext = this.ctx.contextAssembly.formatOpenWindows(
      windowSnapshot.map((w) => w.id),
    );
    const fp = this.ctx.reloadPolicy.buildFingerprint(task, windowSnapshot);
    const reloadPrefix = this.ctx.reloadPolicy.formatReloadOptions(
      this.ctx.reloadPolicy.findMatches(fp, 3),
    );
    const prompt = openWindowsContext + reloadPrefix + task.content;

    // Record user message to tape
    this.ctx.contextAssembly.appendUserMessage(this.ctx.contextTape, task.content, 'main');

    try {
      await agent.session.handleMessage(prompt, {
        role: ephemeralRole,
        source: 'main',
        interactions: task.interactions,
        messageId: task.messageId,
        monitorId,
        onContextMessage: (role, content) => {
          if (role === 'assistant') {
            this.ctx.contextAssembly.appendAssistantMessage(this.ctx.contextTape, content, 'main');
          }
        },
      });

      // Record actions for cache + push callback
      const recordedActions = agent.session.getRecordedActions();
      this.ctx.reloadPolicy.maybeRecord(task, fp, recordedActions);

      this.ctx.timeline.pushAI(ephemeralRole, task.content.slice(0, 100), recordedActions);
    } finally {
      agent.session.setOutputCallback(null);
      agent.currentRole = null;
      await this.ctx.agentPool.disposeEphemeral(agent);
    }
  }

  /**
   * Process queued main tasks when the main agent becomes available.
   */
  async processMainQueue(monitorId = 'monitor-0'): Promise<void> {
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
