/**
 * WindowTaskProcessor — handles window task execution, window queue draining,
 * and window close lifecycle.
 *
 * Extracted from ContextPool to separate window task orchestration concerns.
 */

import type { ContextSource } from './context.js';
import type { PoolContext, Task } from './pool-context.js';

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
        type: 'MESSAGE_QUEUED',
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
          type: 'ERROR',
          error: `Failed to create agent for window ${windowId}`,
        });
        if (!isParallel) await this.processWindowQueue(processingKey);
        return;
      }

      agent.currentRole = agentRole;
      agent.lastUsed = Date.now();

      console.log(
        `[ContextPool] Agent ${agent.instanceId} assigned for window ${windowId} (agentKey: ${agentKey}, role: ${agentRole})`,
      );

      await this.ctx.sharedLogger?.registerAgent(
        agentRole,
        `main-${task.monitorId ?? 'monitor-0'}`,
        windowId,
      );
      await this.sendWindowStatus(windowId, agentRole, 'assigned');

      await this.ctx.sendEvent({
        type: 'MESSAGE_ACCEPTED',
        messageId: task.messageId,
        agentId: agentRole,
      });

      await this.sendWindowStatus(windowId, agentRole, 'active');

      // Compute fingerprint and check for reload matches
      const windowSnapshot = this.ctx.windowState.listWindows();
      const fp = this.ctx.reloadPolicy.buildFingerprint(task, windowSnapshot);
      const reloadPrefix = this.ctx.reloadPolicy.formatReloadOptions(
        this.ctx.reloadPolicy.findMatches(fp, 3),
      );
      const openWindowsContext = this.ctx.contextAssembly.formatOpenWindows(
        windowSnapshot.map((w) => w.id),
      );
      const source: ContextSource = { window: windowId };

      // Record user message immediately
      this.ctx.contextAssembly.appendUserMessage(this.ctx.contextTape, task.content, source);

      // Build prompt: first interaction gets recent main context, subsequent get session continuity
      // canonicalAgent uses agentKey so the group shares one thread
      const canonicalWindow = `window-${agentKey}`;
      const resumeSessionId = this.ctx.savedThreadIds?.[canonicalWindow];
      delete this.ctx.savedThreadIds?.[canonicalWindow];

      let prompt: string;
      if (!resumeSessionId && agent.session.getRawSessionId() === null) {
        // First interaction: include recent main conversation context
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
        // Subsequent interaction: session continuity, no extra context
        prompt = this.ctx.contextAssembly.buildWindowPrompt(task.content, {
          openWindows: openWindowsContext,
          reloadPrefix,
        });
      }

      await agent.session.handleMessage(prompt, {
        role: agentRole,
        source,
        interactions: task.interactions,
        messageId: task.messageId,
        canonicalAgent: canonicalWindow,
        resumeSessionId,
        onContextMessage: (role, content) => {
          if (role === 'assistant') {
            this.ctx.contextAssembly.appendAssistantMessage(this.ctx.contextTape, content, source);
          }
        },
      });

      // Record actions for future cache hits
      const recordedActions = agent.session.getRecordedActions();
      this.ctx.reloadPolicy.maybeRecord(task, fp, recordedActions, windowId);

      // Connect any child windows created by this window agent
      for (const action of recordedActions) {
        if (action.type === 'window.create') {
          this.ctx.windowConnectionPolicy.connectWindow(windowId, action.windowId);
          console.log(
            `[ContextPool] Connected child window ${action.windowId} to parent ${windowId} (group: ${this.ctx.windowConnectionPolicy.getGroupId(windowId)})`,
          );
        }
      }

      // Push to timeline so main agent knows what happened
      this.ctx.timeline.pushAI(agentRole, task.content.slice(0, 100), recordedActions, windowId);

      agent.currentRole = null;
      await this.sendWindowStatus(windowId, agentRole, 'released');
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
      type: 'WINDOW_AGENT_STATUS',
      windowId,
      agentId,
      status,
    });
  }
}
