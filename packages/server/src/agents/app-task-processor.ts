/**
 * AppTaskProcessor — handles app window tasks with scoped, persistent agents.
 *
 * App agents:
 * - Persist for the session lifetime (not tied to window close)
 * - Have only query, command, and relay tools
 * - Get a dynamic system prompt from SKILL.md and protocol manifest
 * - Track the most recently interacted window for tool resolution
 */

import { ServerEventType } from '@yaar/shared';
import type { PoolContext, Task } from './pool-types.js';
import type { AgentProfile } from './profiles/types.js';
import { buildAppAgentProfile, APP_AGENT_TOOL_NAMES } from './profiles/index.js';
import { buildReloadContext, runAgentTurn } from './turn-helpers.js';
import { windowSource, monitorSource } from './context.js';

export class AppTaskProcessor {
  /** Track the most recent windowId for each app (for tool resolution). */
  private activeWindows = new Map<string, string>();
  /** Cached agent profiles per appId. */
  private profiles = new Map<string, AgentProfile>();

  constructor(private readonly ctx: PoolContext) {}

  /**
   * Handle a task for an app window.
   * Creates or reuses the app agent, queues if busy.
   */
  async handleAppTask(task: Task, appId: string): Promise<void> {
    if (!task.windowId) {
      console.error('[AppTaskProcessor] Task missing windowId');
      return;
    }

    const windowId = task.windowId;

    // Update the active window for this app
    this.activeWindows.set(appId, windowId);

    const processingKey = `app-${appId}`;
    const isParallel = !!task.actionId;

    // If the app agent is already busy, try to steer (inject mid-turn message).
    // Falls back to queuing if the provider doesn't support steering.
    if (!isParallel && this.ctx.windowQueuePolicy.isProcessing(processingKey)) {
      const steered = await this.ctx.agentPool.steerAppAgent(appId, task.content);
      if (steered) {
        console.log(
          `[AppTaskProcessor] Steered task ${task.messageId} into running ${appId} agent`,
        );
        const source = windowSource(windowId);
        this.ctx.contextAssembly.appendUserMessage(this.ctx.contextTape, task.content, source);
        await this.ctx.sendEvent({
          type: ServerEventType.MESSAGE_ACCEPTED,
          messageId: task.messageId,
          agentId: `app-${appId}`,
        });
        return;
      }

      // Fallback: queue if steering not supported (e.g. Codex provider)
      const queueSize = this.ctx.windowQueuePolicy.enqueue(processingKey, task);
      console.log(
        `[AppTaskProcessor] Queued task ${task.messageId} for ${appId}, queue size: ${queueSize}`,
      );

      await this.ctx.sendEvent({
        type: ServerEventType.MESSAGE_QUEUED,
        messageId: task.messageId,
        position: queueSize,
      });
      return;
    }

    this.ctx.windowQueuePolicy.setProcessing(processingKey, true);

    const agentRole = isParallel
      ? `app-${appId}-${windowId}/${task.actionId}`
      : `app-${appId}-${task.messageId}`;

    try {
      // Get or create persistent app agent
      const agent = await this.ctx.agentPool.getOrCreateAppAgent(appId);
      if (!agent) {
        this.ctx.windowQueuePolicy.setProcessing(processingKey, false);
        console.error(`[AppTaskProcessor] Failed to create app agent for ${appId}`);
        await this.ctx.sendEvent({
          type: ServerEventType.ERROR,
          error: `Failed to create agent for app ${appId}`,
        });
        if (!isParallel) await this.processQueue(processingKey);
        return;
      }

      // Build or retrieve cached profile
      let profile = this.profiles.get(appId);
      if (!profile) {
        profile = await buildAppAgentProfile(appId);
        this.profiles.set(appId, profile);
      }

      const { fp } = buildReloadContext(this.ctx, task, {
        currentWindowId: windowId,
      });
      const source = windowSource(windowId);

      // Record user message
      this.ctx.contextAssembly.appendUserMessage(this.ctx.contextTape, task.content, source);

      // Capture the app-agent's response text for relaying to the monitor
      let appResponseText = '';

      await runAgentTurn(this.ctx, {
        agent,
        role: agentRole,
        source,
        task,
        prompt: task.content,
        fp,
        windowId,
        monitorId: task.monitorId,
        allowedTools: [...APP_AGENT_TOOL_NAMES],
        systemPromptOverride: profile.systemPrompt,
        model: profile.model,
        onAssistantResponse: (text) => {
          appResponseText = text;
        },
        onBeforeRun: async () => {
          await this.ctx.sharedLogger?.registerAgent(
            agentRole,
            `monitor-${task.monitorId ?? '0'}`,
            windowId,
          );
          await this.sendWindowStatus(windowId, agentRole, 'assigned');
          await this.sendWindowStatus(windowId, agentRole, 'active');
        },
        onAfterRun: async (recordedActions) => {
          // Push to timeline with response text so the monitor agent sees it on next turn
          this.ctx.timeline.pushAI(
            agentRole,
            task.content.slice(0, 100),
            recordedActions,
            windowId,
            appResponseText || undefined,
          );

          // Also append to context tape for logging/debugging
          if (appResponseText && task.monitorId) {
            const monitorSrc = monitorSource(task.monitorId);
            const summary =
              `[app-agent "${appId}" responded to user in window "${windowId}"]\n` +
              appResponseText;
            this.ctx.contextAssembly.appendAssistantMessage(
              this.ctx.contextTape,
              summary,
              monitorSrc,
            );
          }
        },
        onFinally: async () => {
          await this.sendWindowStatus(windowId, agentRole, 'released');
        },
      });
    } finally {
      this.ctx.windowQueuePolicy.setProcessing(processingKey, false);
      if (!isParallel) await this.processQueue(processingKey);
    }
  }

  /**
   * Get the most recently active windowId for an app.
   */
  getActiveWindowId(appId: string): string | undefined {
    return this.activeWindows.get(appId);
  }

  /**
   * Handle a window being closed — interrupt the app agent if it's running for this window,
   * clear queued tasks, and remove active window tracking.
   */
  async handleWindowClose(windowId: string, appId: string): Promise<void> {
    const processingKey = `app-${appId}`;

    // Clear any queued tasks for this app
    this.ctx.windowQueuePolicy.clearQueue(processingKey);

    // Remove active window tracking
    if (this.activeWindows.get(appId) === windowId) {
      this.activeWindows.delete(appId);
    }

    // Interrupt the app agent if it's currently running
    const agent = this.ctx.agentPool.getAppAgent(appId);
    if (agent?.session.isRunning()) {
      console.log(
        `[AppTaskProcessor] Interrupting app agent for ${appId} (window ${windowId} closed)`,
      );
      await agent.session.interrupt();
    }

    // Clear processing state so the agent isn't stuck in "busy" state
    this.ctx.windowQueuePolicy.setProcessing(processingKey, false);
  }

  /**
   * Clean up all tracked state.
   */
  disposeAll(): void {
    this.activeWindows.clear();
    this.profiles.clear();
  }

  private async processQueue(processingKey: string): Promise<void> {
    const next = this.ctx.windowQueuePolicy.dequeue(processingKey);
    if (next) {
      // Re-derive appId from the task's windowId
      const appId = next.task.windowId
        ? this.ctx.windowState.getAppIdForWindow(next.task.windowId)
        : undefined;
      if (appId) {
        await this.handleAppTask(next.task, appId);
      }
    }
  }

  private async sendWindowStatus(
    windowId: string,
    agentId: string,
    status: 'assigned' | 'active' | 'released',
  ): Promise<void> {
    await this.ctx.sendEvent({
      type: ServerEventType.WINDOW_AGENT_STATUS,
      windowId,
      agentId,
      status,
    });
  }
}
