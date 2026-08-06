/**
 * AppTaskProcessor — handles app window tasks with scoped, persistent agents.
 *
 * App agents:
 * - Persist for the session lifetime (not tied to window close)
 * - Have only query, command, and relay tools
 * - Get a dynamic system prompt from `agent/prompt.md` and the protocol manifest
 * - Track the most recently interacted window for tool resolution
 */

import { ServerEventType } from '@yaar/shared';
import type { PoolContext, Task } from './pool-types.js';
import type { AgentProfile } from './profiles/types.js';
import { buildAppAgentProfile, turnOptionsFor } from './profiles/index.js';
import { buildReloadContext, runAgentTurn } from './turn-helpers.js';
import { windowSource, monitorSource } from './context.js';
import { appRolePrefix, monitorRole } from './roles.js';
import { appAgentKey } from './agent-pool.js';
import { AppStateHandoffStore, formatAppStateHandoffNotice } from './app-state-handoff.js';
import { captureDeclaredAppState } from '../features/window/app-protocol.js';

/**
 * The window queue's key for a (monitor, app) pair — what `WindowQueuePolicy` files
 * this app's queue and its is-processing flag under.
 *
 * A third spelling of the same pair, beside {@link appAgentKey} (the pool's map key)
 * and {@link appRolePrefix} (the per-turn role, in `roles.ts`). The three keyspaces
 * are deliberately distinct — this one shares a namespace with plain-window queue
 * keys — but each has exactly one owner now, because all three were hand-rebuilt at
 * call sites and two of them had already drifted: this key and the role prefix put
 * the monitor and the app in **opposite orders**, which reads as a typo right up
 * until you swap them and the queue silently stops matching.
 */
export function appProcessingKey(monitorId: string, appId: string): string {
  return `app-${monitorId}-${appId}`;
}

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

    this.activeWindows.set(appAgentKey(monitorId, appId), windowId);

    const processingKey = appProcessingKey(monitorId, appId);
    const isParallel = !!task.actionId;

    // If the app agent is already busy, try to steer (inject mid-turn message).
    // Falls back to queuing if the provider doesn't support steering.
    //
    // A `fresh` task never steers: steering injects it into the very turn — and the
    // very memory — it asked not to be answered from. It queues instead, and the
    // release happens when it reaches the front. Deliberately not an interrupt: the
    // flag says the *next* request needs no history, not that the running one should
    // be abandoned.
    if (!isParallel && this.ctx.windowQueuePolicy.isProcessing(processingKey)) {
      const steered =
        !task.fresh && (await this.ctx.agentPool.steerAppAgent(monitorId, appId, task.content));
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

    const rolePrefix = appRolePrefix(monitorId, appId);
    const agentRole = isParallel
      ? `${rolePrefix}-${windowId}/${task.actionId}`
      : `${rolePrefix}-${task.messageId}`;

    try {
      // Retire the incumbent before asking for one, so the turn below runs on an agent
      // that remembers nothing. Inside the processing lock on purpose: between the
      // dispose and the create there is a window where the map is empty, and holding
      // the lock is what keeps another task for this app from creating the replacement
      // this turn is about to ask for.
      if (task.fresh) await this.releaseAgent(monitorId, appId);

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
        systemPromptOverride: profile.systemPrompt,
        ...turnOptionsFor(profile, this.ctx.providerType ?? ''),
        onAssistantResponse: (text) => {
          appResponseText = text;
        },
        onBeforeRun: async () => {
          await this.ctx.sharedLogger?.registerAgent(agentRole, monitorRole(monitorId), windowId);
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
   * Retire one app's agent on one monitor so the next turn starts from nothing.
   *
   * The agent's memory lives in its provider session, which `disposeAppAgent` ends —
   * the context tape is a log, and nothing reads it back into a prompt, so there is
   * no branch to prune here.
   *
   * The handoff fingerprints must go with it. They exist to tell an agent that comes
   * *back* to a window whether the app's state moved while it was away; handed to an
   * agent that was never there, `<app_state_since_handoff changed="true"/>` claims a
   * handoff that never happened. Every window of this app on this monitor is cleared,
   * not just the one this task names — the dead agent may have driven several, and its
   * successor has seen none of them.
   *
   * Sub-agents deliberately survive. A persona's owner is the (monitor, app) pair, not
   * the app agent — the iframe spawns them and they exist whether or not an app agent
   * ever did — so retiring the operator must not take the cast down with it.
   */
  private async releaseAgent(monitorId: string, appId: string): Promise<void> {
    if (!this.ctx.agentPool.hasAppAgent(monitorId, appId)) return;

    await this.ctx.agentPool.disposeAppAgent(monitorId, appId);

    for (const handle of this.ctx.windowState.handleMap.listByMonitor(monitorId)) {
      if (this.ctx.windowState.getAppIdForWindow(handle) === appId) {
        this.handoffState.forget(handle);
      }
    }
  }

  /** The most recently active windowId for an app on a monitor. */
  getActiveWindowId(monitorId: string, appId: string): string | undefined {
    return this.activeWindows.get(appAgentKey(monitorId, appId));
  }

  /**
   * A window closed: interrupt the app agent if it's running for this window,
   * clear queued tasks, and remove active window tracking.
   */
  async handleWindowClose(windowId: string, appId: string, monitorId?: string): Promise<void> {
    // The window is already gone from the registry by the time this runs, so the
    // caller passes the monitor it belonged to.
    const owner = monitorId ?? this.ownerMonitor(windowId);
    const key = appAgentKey(owner, appId);
    const processingKey = appProcessingKey(owner, appId);

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

    if (this.activeWindows.get(key) === windowId) {
      this.activeWindows.delete(key);
    }

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
   * A profile is built once from `protocol.json`, `agent/prompt.md` and `controls`,
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
