/**
 * WindowTaskProcessor — handles window task execution, window queue draining,
 * and window close lifecycle.
 *
 * Extracted from ContextPool to separate window task orchestration concerns.
 */

import { ServerEventType } from '@yaar/shared';
import type { PoolContext, Task } from './pool-types.js';
import { getToolNames } from '../mcp/server.js';
import { buildReloadContext, runAgentTurn } from './turn-helpers.js';

export class WindowTaskProcessor {
  constructor(private readonly ctx: PoolContext) {}

  async handleWindowTask(task: Task): Promise<void> {
    if (!task.windowId) {
      console.error('[ContextPool] Window task missing windowId');
      return;
    }

    const windowId = task.windowId;

    // Resolve agent key: if this window belongs to a group, route to the group's agent
    const groupId = this.ctx.windowConnectionPolicy.getGroupId(windowId);
    const agentKey = groupId ?? windowId;
    const processingKey = task.actionId ?? agentKey;
    const isParallel = !!task.actionId;
    console.log(
      `[ContextPool] handleWindowTask: ${task.messageId} for ${windowId} (agentKey: ${agentKey}, key: ${processingKey}, parallel: ${isParallel})`,
    );

    // Queue if this key is already busy (skip for parallel actions)
    if (!isParallel && this.ctx.windowQueuePolicy.isProcessing(processingKey)) {
      const queueSize = this.ctx.windowQueuePolicy.enqueue(processingKey, task);
      console.log(
        `[ContextPool] Queued task ${task.messageId} for ${processingKey}, queue size: ${queueSize}`,
      );

      await this.ctx.sendEvent({
        type: ServerEventType.MESSAGE_QUEUED,
        messageId: task.messageId,
        position: queueSize,
      });
      return;
    }

    this.ctx.windowQueuePolicy.setProcessing(processingKey, true);

    const agentRole = isParallel ? `window-${windowId}/${task.actionId}` : `window-${windowId}`;

    try {
      // Get or create persistent window agent — keyed by agentKey (groupId or windowId)
      const agent = await this.ctx.agentPool.getOrCreateWindowAgent(agentKey);
      if (!agent) {
        this.ctx.windowQueuePolicy.setProcessing(processingKey, false);
        console.error(`[ContextPool] Failed to create window agent for ${agentKey}`);
        await this.ctx.sendEvent({
          type: ServerEventType.ERROR,
          error: `Failed to create agent for window ${windowId}`,
        });
        if (!isParallel) await this.processWindowQueue(processingKey);
        return;
      }

      console.log(
        `[ContextPool] Agent ${agent.instanceId} assigned for window ${windowId} (agentKey: ${agentKey}, role: ${agentRole})`,
      );

      const { openWindowsContext, fp, reloadPrefix } = buildReloadContext(this.ctx, task, {
        currentWindowId: windowId,
      });
      const source = { window: windowId } as const;

      // Record user message immediately
      this.ctx.contextAssembly.appendUserMessage(this.ctx.contextTape, task.content, source);

      // Build prompt: first interaction gets recent main context, subsequent get session continuity
      // canonicalAgent uses agentKey so the group shares one thread
      const canonicalWindow = `window-${agentKey}`;
      const resumeSessionId = this.ctx.savedThreadIds?.[canonicalWindow];
      delete this.ctx.savedThreadIds?.[canonicalWindow];

      let prompt: string;
      if (!resumeSessionId && agent.session.getRawSessionId() === null) {
        const recentContext = this.ctx.contextAssembly.buildWindowInitialContext(
          this.ctx.contextTape,
        );
        prompt =
          recentContext +
          this.ctx.contextAssembly.buildWindowPrompt(task.content, {
            openWindows: openWindowsContext,
            reloadPrefix,
          });
      } else {
        prompt = this.ctx.contextAssembly.buildWindowPrompt(task.content, {
          openWindows: openWindowsContext,
          reloadPrefix,
        });
      }

      await runAgentTurn(this.ctx, {
        agent,
        role: agentRole,
        source,
        task,
        prompt,
        fp,
        windowId,
        canonicalAgent: canonicalWindow,
        resumeSessionId,
        monitorId: task.monitorId,
        allowedTools: getToolNames(),
        onBeforeRun: async () => {
          await this.ctx.sharedLogger?.registerAgent(
            agentRole,
            `main-${task.monitorId ?? '0'}`,
            windowId,
          );
          await this.sendWindowStatus(windowId, agentRole, 'assigned');
          await this.sendWindowStatus(windowId, agentRole, 'active');
        },
        onAfterRun: async (recordedActions) => {
          for (const action of recordedActions) {
            if (action.type === 'window.create') {
              this.ctx.windowConnectionPolicy.connectWindow(windowId, action.windowId);
              console.log(
                `[ContextPool] Connected child window ${action.windowId} to parent ${windowId} (group: ${this.ctx.windowConnectionPolicy.getGroupId(windowId)})`,
              );
            }
          }
          this.ctx.timeline.pushAI(
            agentRole,
            task.content.slice(0, 100),
            recordedActions,
            windowId,
          );
        },
        onFinally: async () => {
          await this.sendWindowStatus(windowId, agentRole, 'released');
        },
      });
    } finally {
      this.ctx.windowQueuePolicy.setProcessing(processingKey, false);
      if (!isParallel) await this.processWindowQueue(processingKey);
    }
  }

  async processWindowQueue(windowId: string): Promise<void> {
    const next = this.ctx.windowQueuePolicy.dequeue(windowId);
    if (next) {
      console.log(
        `[ContextPool] Processing queued task ${next.task.messageId} for window ${windowId}`,
      );
      await this.handleWindowTask(next.task);
    }
  }

  /**
   * Handle window close: dispose window agent, push callback, prune context.
   * Called by SessionManager when a window close action is processed.
   */
  handleWindowClose(windowId: string): void {
    // Resolve group BEFORE handleClose modifies it
    const groupId = this.ctx.windowConnectionPolicy.getGroupId(windowId);
    const agentKey = groupId ?? windowId;

    // NOTE: No timeline entry pushed here.
    // - User-initiated closes are already in the timeline via pushUserInteractions()
    // - AI-initiated closes are already captured in recordedActions summaries
    //   from processEphemeralTask() or handleWindowTask()

    // Update group state and decide if agent should be disposed
    const closeResult = this.ctx.windowConnectionPolicy.handleClose(windowId);

    if (closeResult.shouldDisposeAgent) {
      // Last window in group (or standalone) — dispose the agent
      this.ctx.agentPool.disposeWindowAgent(agentKey).catch((err) => {
        console.error(`[ContextPool] Error disposing window agent for ${agentKey}:`, err);
      });
    }
    // Agent survives if other windows remain in the group

    // Prune this window's context from tape (regardless of group status)
    const pruned = this.ctx.contextTape.pruneWindow(windowId);
    if (pruned.length > 0) {
      console.log(`[ContextPool] Pruned ${pruned.length} messages from closed window ${windowId}`);
    }

    // Clean up agent map entry for this window
    this.ctx.windowAgentMap.delete(windowId);
  }

  private async sendWindowStatus(
    windowId: string,
    agentId: string,
    status: 'assigned' | 'active' | 'released',
  ): Promise<void> {
    this.ctx.windowAgentMap.set(windowId, agentId);
    await this.ctx.sendEvent({
      type: ServerEventType.WINDOW_AGENT_STATUS,
      windowId,
      agentId,
      status,
    });
  }
}
