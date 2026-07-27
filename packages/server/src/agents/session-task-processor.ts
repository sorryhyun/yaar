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
import { buildReloadContext, runAgentTurn } from './turn-helpers.js';
import { SESSION_AGENT_PROFILE, claudeModelToCodex } from './profiles/index.js';
import type { PooledAgent } from './agent-pool.js';
import type { PoolContext, Task } from './pool-types.js';

export class SessionTaskProcessor {
  constructor(private readonly ctx: PoolContext) {}

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
    const role = `session-${task.messageId}`;

    // If the deputy is mid-turn, steer it rather than spawning a parallel run.
    if (agent.session.isRunning()) {
      const steered = await agent.session.steer(task.content);
      if (steered) {
        this.ctx.contextAssembly.appendUserMessage(this.ctx.contextTape, task.content, source);
        await this.ctx.sendEvent({
          type: ServerEventType.MESSAGE_ACCEPTED,
          messageId: task.messageId,
          agentId: agent.currentRole ?? role,
        });
        return;
      }
    }

    const { openWindowsContext, fp, reloadPrefix } = buildReloadContext(this.ctx, task);
    const prompt = openWindowsContext + reloadPrefix + task.content;
    this.ctx.contextAssembly.appendUserMessage(this.ctx.contextTape, task.content, source);

    const isCodex = this.ctx.providerType === 'codex';
    await runAgentTurn(this.ctx, {
      agent,
      role,
      source,
      task,
      prompt,
      fp,
      monitorId,
      systemPromptOverride: SESSION_AGENT_PROFILE.systemPrompt,
      allowedTools: isCodex ? undefined : SESSION_AGENT_PROFILE.allowedTools,
      model: isCodex
        ? claudeModelToCodex(SESSION_AGENT_PROFILE.model)
        : SESSION_AGENT_PROFILE.model,
    });
  }
}
