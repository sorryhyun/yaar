/**
 * SessionTaskProcessor — runs turns for the **session agent** (the user's deputy).
 *
 * The third of the three task roles, alongside `MonitorTaskProcessor` and
 * `AppTaskProcessor`. It owns what is specific to the deputy: the lazy singleton
 * agent, the monitor pin that outlives the turn, the `session-*` role string that
 * unlocks `yaar://session/*`, and the session profile's prompt/model/tools.
 *
 * It deliberately does NOT own the reset guard or inflight accounting — those are
 * pool-wide invariants and stay in `ContextPool.handleSessionTask()`.
 */

import { ServerEventType } from '@yaar/shared';
import { monitorSource } from './context.js';
import { sessionRole } from './roles.js';
import { buildReloadContext, runAgentTurn } from './turn-helpers.js';
import { SESSION_AGENT_PROFILE, turnOptionsFor } from './profiles/index.js';
import type { PooledAgent } from './agent-roster.js';
import type { SessionPoolContext, Task } from './pool-types.js';

export class SessionTaskProcessor {
  constructor(private readonly ctx: SessionPoolContext) {}

  /**
   * The session agent, born on first use. There is at most one per session; a
   * second caller during creation gets whatever `AgentPool` hands back.
   */
  async getOrCreateAgent(): Promise<PooledAgent | null> {
    const existing = this.ctx.agentPool.getSessionAgent();
    if (existing) return existing;
    return this.ctx.agentPool.createSessionAgent();
  }

  /**
   * The turn this processor has taken and not finished, claimed before the first await.
   *
   * Callers no longer wait for a turn before handing over the next message, so two can
   * arrive while the agent is still being created or its turn is being set up, when
   * neither can be steered. The second waits behind the first rather than starting a
   * turn of its own on the same agent.
   */
  private turn: Promise<void> | null = null;

  /**
   * Run one session-agent turn.
   *
   * Caller (`ContextPool.handleSessionTask`) has already rejected the task if the
   * pool is resetting and has entered inflight tracking.
   */
  async process(task: Task): Promise<void> {
    // The session agent is the user's deputy, so its monitor is the user's — it comes
    // from the connection that spoke, and arrives on the task.
    const monitorId = task.monitorId;
    if (!monitorId) {
      throw new Error(
        `Cannot run session task ${task.messageId}: no monitor. A user-scoped task takes ` +
          `its monitor from the connection that sent it.`,
      );
    }

    // If the deputy is mid-turn, steer it rather than queueing a run behind it.
    const running = this.ctx.agentPool.getSessionAgent();
    if (this.turn && running?.session.isRunning()) {
      const steered = await running.session.steer(task.content);
      if (steered) {
        // Pin as a turn would: the steered message is about the user's monitor now.
        this.ctx.agentPool.setSessionAgentMonitor(monitorId);
        this.ctx.contextAssembly.appendUserMessage(
          this.ctx.contextTape,
          task.content,
          monitorSource(monitorId),
        );
        await this.ctx.sendEvent({
          type: ServerEventType.MESSAGE_ACCEPTED,
          messageId: task.messageId,
          agentId: running.currentRole ?? sessionRole(task.messageId),
        });
        return;
      }
    }

    const previous = this.turn;
    let settle!: () => void;
    const mine = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.turn = mine;
    try {
      await previous;
      await this.runTurn(task, monitorId);
    } finally {
      settle();
      if (this.turn === mine) this.turn = null;
    }
  }

  private async runTurn(task: Task, monitorId: string): Promise<void> {
    const agent = await this.getOrCreateAgent();
    if (!agent) {
      await this.ctx.sendEvent({
        type: ServerEventType.ERROR,
        error: 'No AI provider available for the session agent.',
      });
      return;
    }

    // Pin before the turn: the MCP requests this turn makes resolve their monitor by
    // asking the pool which monitor this agent is on. The pin outlives the turn — an
    // idle deputy's monitor is the one it last acted on, which is the only honest answer.
    this.ctx.agentPool.setSessionAgentMonitor(monitorId);

    const source = monitorSource(monitorId);
    const role = sessionRole(task.messageId);

    const { openWindowsContext, fp, reloadPrefix } = buildReloadContext(this.ctx, task);
    const prompt = openWindowsContext + reloadPrefix + task.content;
    this.ctx.contextAssembly.appendUserMessage(this.ctx.contextTape, task.content, source);

    await runAgentTurn(this.ctx, {
      agent,
      role,
      source,
      task,
      prompt,
      fp,
      monitorId,
      systemPromptOverride: SESSION_AGENT_PROFILE.systemPrompt,
      ...turnOptionsFor(SESSION_AGENT_PROFILE, this.ctx.providerType ?? ''),
    });
  }
}
