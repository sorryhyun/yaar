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
import {
  buildAppAgentProfile,
  APP_AGENT_TOOL_NAMES,
  claudeModelToCodex,
} from './profiles/index.js';
import { buildReloadContext, runAgentTurn } from './turn-helpers.js';
import { windowSource, monitorSource } from './context.js';
import { appAgentKey } from './agent-pool.js';
import { AppStateHandoffStore, formatAppStateHandoffNotice } from './app-state-handoff.js';
import { captureDeclaredAppState } from '../features/window/app-protocol.js';

export class AppTaskProcessor {
  /** Track the most recent windowId per `{monitorId}::{appId}` (for tool resolution). */
  private activeWindows = new Map<string, string>();
  /** Cached agent profiles per appId (a profile depends only on the app). */
  private profiles = new Map<string, AgentProfile>();
  /** Fingerprints captured immediately before an app agent is released. */
  private handoffState = new AppStateHandoffStore();

  constructor(private readonly ctx: PoolContext) {}

  /**
   * The monitor that owns an app agent: the monitor of the window it drives.
   * A task's own monitorId only says who *sent* it, which for a cross-monitor
   * direct message is not the monitor the app window lives on.
   */
  private ownerMonitor(windowId: string, task?: Task): string {
    const monitorId = this.ctx.windowState.getMonitorForWindow(windowId) ?? task?.monitorId;
    if (!monitorId) {
      throw new Error(
        `Cannot route app task for window ${windowId}: no monitor. The window is not ` +
          `registered and the task names no monitor of its own.`,
      );
    }
    return monitorId;
  }

  /**
   * Handle a task for an app window.
   * Creates or reuses the app agent for that app *on that window's monitor*, queues if busy.
   */
  async handleAppTask(task: Task, appId: string): Promise<void> {
    if (!task.windowId) {
      console.error('[AppTaskProcessor] Task missing windowId');
      return;
    }

    const monitorId = this.ownerMonitor(task.windowId, task);
    // Canonicalize to the monitor-scoped handle ("0/devtools") before anything files
    // state under it. A task from the client already carries one — the frontend keys
    // every window that way — but a task from an agent carries the raw, AI-facing id
    // ("devtools"), because that is how `direct_message` and the window verbs name
    // windows. Both reach the same window here, and the difference used to survive all
    // the way out to `WINDOW_AGENT_STATUS`, which then named a window the client had
    // never heard of: the app agent ran, and the window's badge never lit. It also split
    // `activeWindows`, the context tape's window source, and the reload fingerprint
    // across two spellings of one window.
    const windowId =
      this.ctx.windowState.handleMap.resolve(task.windowId, monitorId) ?? task.windowId;

    // Update the active window for this app on this monitor
    this.activeWindows.set(appAgentKey(monitorId, appId), windowId);

    const processingKey = `app-${monitorId}-${appId}`;
    const isParallel = !!task.actionId;

    // If the app agent is already busy, try to steer (inject mid-turn message).
    // Falls back to queuing if the provider doesn't support steering.
    if (!isParallel && this.ctx.windowQueuePolicy.isProcessing(processingKey)) {
      const steered = await this.ctx.agentPool.steerAppAgent(monitorId, appId, task.content);
      if (steered) {
        console.log(
          `[AppTaskProcessor] Steered task ${task.messageId} into running ${appId} agent`,
        );
        const source = windowSource(windowId);
        this.ctx.contextAssembly.appendUserMessage(this.ctx.contextTape, task.content, source);
        await this.ctx.sendEvent({
          type: ServerEventType.MESSAGE_ACCEPTED,
          messageId: task.messageId,
          agentId: processingKey,
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

    // Roles keep the `app-{appId}` prefix (principalRole() and hasRolePrefix()
    // both key off it) and carry the owning monitor after it.
    const agentRole = isParallel
      ? `app-${appId}-m${monitorId}-${windowId}/${task.actionId}`
      : `app-${appId}-m${monitorId}-${task.messageId}`;

    try {
      // Get or create the persistent app agent for this app on this monitor
      const agent = await this.ctx.agentPool.getOrCreateAppAgent(monitorId, appId);
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

      const stateKeys = profile.appStateKeys ?? [];
      const stateNotice = await this.buildHandoffNotice(windowId, stateKeys);
      const prompt = stateNotice ? `${stateNotice}\n\n${task.content}` : task.content;

      const { fp } = buildReloadContext(this.ctx, task, {
        currentWindowId: windowId,
        monitorId,
      });
      const source = windowSource(windowId);

      // Record user message
      this.ctx.contextAssembly.appendUserMessage(this.ctx.contextTape, prompt, source);

      // Capture the app-agent's response text for relaying to the monitor
      let appResponseText = '';

      await runAgentTurn(this.ctx, {
        agent,
        role: agentRole,
        source,
        task,
        prompt,
        fp,
        windowId,
        // The turn runs on the window's monitor, not the sender's — this scopes the
        // window handles the agent's actions resolve against, and the monitor its
        // `relay` reaches.
        monitorId,
        // Codex doesn't filter tools per-thread via allowedTools — its per-thread
        // mcp_servers override selects whole namespaces, not tools within one (see
        // codexServerFilter) — so pass undefined and let it use all of them. Mirrors
        // the monitor/session agents' Codex handling.
        allowedTools: this.ctx.providerType === 'codex' ? undefined : [...APP_AGENT_TOOL_NAMES],
        systemPromptOverride: profile.systemPrompt,
        model:
          this.ctx.providerType === 'codex' ? claudeModelToCodex(profile.model) : profile.model,
        onAssistantResponse: (text) => {
          appResponseText = text;
        },
        onBeforeRun: async () => {
          await this.ctx.sharedLogger?.registerAgent(agentRole, `monitor-${monitorId}`, windowId);
          await this.sendWindowStatus(windowId, agentRole, 'assigned');
          await this.sendWindowStatus(windowId, agentRole, 'active');
        },
        onAfterRun: async (recordedActions) => {
          // Fire message hook if the originating agent requested it.
          // Skip it when the turn was interrupted (e.g. "stop all") — otherwise
          // the hook re-enqueues a monitor task and resurrects the monitor agent
          // the user just asked to stop.
          const hookWillFire =
            task.hook === 'response' && !!task.monitorId && !agent.session.wasInterrupted();

          // Push to timeline so the monitor agent sees it on its next turn — but only
          // carry the response text when no hook will deliver it. Both sinks land in
          // the monitor's next prompt, so including it in both makes the monitor read
          // the app agent's entire response twice, back to back.
          this.ctx
            .timelineFor(monitorId)
            .pushAI(
              agentRole,
              task.content.slice(0, 100),
              recordedActions,
              windowId,
              hookWillFire ? undefined : appResponseText || undefined,
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

          if (hookWillFire) {
            this.ctx.notifyHookResponse(appId, windowId, task.monitorId!, appResponseText);
          }
        },
        onFinally: async () => {
          await this.captureHandoffState(windowId, stateKeys);
          await this.sendWindowStatus(windowId, agentRole, 'released');
        },
      });
    } finally {
      this.ctx.windowQueuePolicy.setProcessing(processingKey, false);
      if (!isParallel) await this.processQueue(processingKey);
    }
  }

  /**
   * Get the most recently active windowId for an app on a monitor.
   */
  getActiveWindowId(monitorId: string, appId: string): string | undefined {
    return this.activeWindows.get(appAgentKey(monitorId, appId));
  }

  /**
   * Handle a window being closed — interrupt the app agent if it's running for this window,
   * clear queued tasks, and remove active window tracking.
   */
  async handleWindowClose(windowId: string, appId: string, monitorId?: string): Promise<void> {
    // The window is already gone from the registry by the time this runs, so the
    // caller passes the monitor it belonged to.
    const owner = monitorId ?? this.ownerMonitor(windowId);
    const key = appAgentKey(owner, appId);
    const processingKey = `app-${owner}-${appId}`;

    // Clear any queued tasks for this app on this monitor. Each is a click or message the
    // user made in a window that has since closed — it will not run, and saying so is the
    // difference between a cancelled action and one that appears to still be pending.
    for (const { task } of this.ctx.windowQueuePolicy.clearQueue(processingKey)) {
      await this.ctx.sendEvent({
        type: ServerEventType.ERROR,
        error: `Message dropped: window ${windowId} was closed before it ran.`,
        messageId: task.messageId,
        ...(owner ? { monitorId: owner } : {}),
      });
    }

    // Remove active window tracking
    if (this.activeWindows.get(key) === windowId) {
      this.activeWindows.delete(key);
    }

    // Interrupt the app agent if it's currently running
    const agent = this.ctx.agentPool.getAppAgent(owner, appId);
    if (agent?.session.isRunning()) {
      console.log(
        `[AppTaskProcessor] Interrupting app agent for ${appId} on monitor ${owner} (window ${windowId} closed)`,
      );
      await agent.session.interrupt();
    }

    // Clear processing state so the agent isn't stuck in "busy" state
    this.ctx.windowQueuePolicy.setProcessing(processingKey, false);
    this.handoffState.forget(windowId);
  }

  /**
   * Forget the cached profile for one app — its files on disk just changed.
   *
   * A profile is built once from `protocol.json`, `SKILL.md`/`AGENTS.md` and `controls`,
   * and cached because none of that moves during a session. A deploy moves all of it. The
   * cache is the whole staleness: the prompt is passed per turn (`systemPromptOverride`),
   * so dropping the entry is enough to rebuild the app agent's instructions from the new
   * build on its next turn — the agent itself, and the memory of what the user was doing,
   * survive. Without this it keeps calling yesterday's command names.
   */
  invalidateProfile(appId: string): void {
    this.profiles.delete(appId);
  }

  /**
   * Drop the window tracking for one monitor (its app agents are disposed with it).
   */
  clearMonitor(monitorId: string): void {
    const prefix = appAgentKey(monitorId, '');
    for (const key of this.activeWindows.keys()) {
      if (key.startsWith(prefix)) this.activeWindows.delete(key);
    }
    this.handoffState.forgetMonitor(monitorId);
  }

  /**
   * Clean up all tracked state.
   */
  disposeAll(): void {
    this.activeWindows.clear();
    this.profiles.clear();
    this.handoffState.clear();
  }

  private async buildHandoffNotice(
    windowId: string,
    stateKeys: readonly string[],
  ): Promise<string> {
    if (stateKeys.length === 0 || !this.handoffState.has(windowId)) return '';
    const current = await captureDeclaredAppState(
      this.ctx.windowState,
      windowId,
      stateKeys,
      this.ctx.sessionId,
    );
    if (!current) return '';
    const changed = this.handoffState.changedSinceHandoff(windowId, current);
    return changed === undefined ? '' : formatAppStateHandoffNotice(changed);
  }

  private async captureHandoffState(windowId: string, stateKeys: readonly string[]): Promise<void> {
    if (stateKeys.length === 0) return;
    const state = await captureDeclaredAppState(
      this.ctx.windowState,
      windowId,
      stateKeys,
      this.ctx.sessionId,
    );
    if (state) this.handoffState.remember(windowId, state);
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
