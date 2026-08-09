/**
 * AppTaskProcessor — handles app window tasks with scoped, persistent agents.
 *
 * App agents:
 * - Live as long as the app has a window on their monitor, and are retired when its last
 *   one closes (with their memory — see {@link AppTaskProcessor.releaseAgent})
 * - Have only query, command, and relay tools
 * - Get a dynamic system prompt from `agent/prompt.md` and the protocol manifest
 * - Track the most recently interacted window for tool resolution
 */

import { ServerEventType } from '@yaar/shared';
import type { AppPoolContext, Task } from './pool-types.js';
import type { AgentProfile } from './profiles/types.js';
import { buildAppAgentProfile, turnOptionsFor } from './profiles/index.js';
import { buildReloadContext, runAgentTurn } from './turn-helpers.js';
import { windowSource, monitorSource } from './context.js';
import { appRolePrefix, monitorRole } from './roles.js';
import { appAgentKey } from './agent-roster.js';
import { enqueueOrReject } from './queue-refusal.js';
import { AppStateHandoffStore, formatAppStateHandoffNotice } from './app-state-handoff.js';
import { captureDeclaredAppState } from '../features/window/app-protocol.js';
import { createLogger } from '../observability/log.js';

const log = createLogger('AppTaskProcessor');

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
  /**
   * The main turn running under a processing key, so a window close can wait it out
   * instead of racing it. Resolves — never rejects — once `handleAppTask`'s `finally`
   * has run, which is the moment the app is genuinely idle. See
   * {@link handleWindowClose}.
   *
   * Only the turns the processing flag governs are tracked; a parallel (`actionId`)
   * task never set that flag and never blocked one. `AgentSession` serializes those
   * against the main turn on its own.
   */
  private inflight = new Map<string, Promise<void>>();
  /**
   * Processing keys whose agent must be retired the moment its turn stops.
   *
   * A close that lands mid-turn cannot dispose the agent where it stands — the turn is
   * still running on it — and it cannot dispose it after `await`ing the turn either,
   * because by then the turn's own `finally` has already drained the queue onto that
   * same agent. So the close leaves the request here and the turn's teardown honours it,
   * inside the processing lock, between the last message and the first queued one.
   */
  private pendingRelease = new Set<string>();

  constructor(private readonly ctx: AppPoolContext) {}

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
      log.error('task missing windowId', { messageId: task.messageId, appId });
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
        log.info('steered task into running app agent', { messageId: task.messageId, appId });
        const source = windowSource(windowId);
        this.ctx.contextAssembly.appendUserMessage(this.ctx.contextTape, task.content, source);
        await this.ctx.sendEvent({
          type: ServerEventType.MESSAGE_ACCEPTED,
          messageId: task.messageId,
          agentId: processingKey,
        });
        return;
      }

      // Fallback: queue if steering not supported (e.g. Codex provider). Bounded, and
      // refused out loud when the bound is reached — a wedged app agent used to collect
      // clicks forever, and the user's only clue was a chip that never moved.
      await enqueueOrReject({
        sendEvent: (event) => this.ctx.sendEvent(event),
        queue: {
          canEnqueue: () => this.ctx.windowQueuePolicy.canEnqueue(processingKey),
          enqueue: () => this.ctx.windowQueuePolicy.enqueue(processingKey, task),
        },
        task,
        monitorId,
        maxQueueSize: this.ctx.windowQueuePolicy.maxSize,
        why: 'Please wait for current operations to complete.',
        onQueued: (position) =>
          log.info('queued app task', { messageId: task.messageId, appId, monitorId, position }),
      });
      return;
    }

    this.ctx.windowQueuePolicy.setProcessing(processingKey, true);

    // Published in the same synchronous block as the flag, so there is no instant in
    // which the app reads as busy with no turn to wait for.
    let settleTurn: () => void = () => {};
    if (!isParallel) {
      this.inflight.set(
        processingKey,
        new Promise<void>((resolve) => {
          settleTurn = resolve;
        }),
      );
    }

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
        log.error('failed to create app agent', { appId, monitorId });
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
      // Order matters: settle *before* draining. A close waiting on this turn resumes on
      // the microtask after the `await` below, by which point the flag is already the
      // next turn's to own — so the waiter finds the app idle-or-busy correctly instead
      // of clearing a flag `processQueue` has just set.
      settleTurn();
      if (!isParallel) this.inflight.delete(processingKey);
      // A close that landed mid-turn asked for this agent to be retired. Here, and not
      // where the close ran: this is inside the processing lock and ahead of the drain,
      // so the queued messages below are answered by the *replacement* agent rather than
      // starting a turn on one that is about to be disposed underneath them.
      if (this.pendingRelease.delete(processingKey)) {
        await this.releaseAgent(monitorId, appId);
      }
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
   * Sub-agents deliberately survive *this*. A persona's owner is the (monitor, app) pair,
   * not the app agent — the iframe spawns them and they exist whether or not an app agent
   * ever did — so retiring the operator must not take the cast down with it. On the
   * last-window close they are reclaimed too, but by `WindowEventCoordinator` and on its
   * own condition, not as a consequence of this.
   *
   * Two callers: a `fresh: true` task, which retires the agent so the message it carries
   * is answered by one that remembers nothing, and the close of an app's last window on
   * this monitor. Both mean the same thing to the agent — end of memory — which is why
   * they share this and not merely a call to `disposeAppAgent`: the handoff fingerprints
   * have to go with it either way.
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
   * A window closed: interrupt the app agent if it's running for this window, clear
   * queued tasks, remove active window tracking, and — when this was the app's last
   * window on the monitor — retire the agent along with it.
   *
   * `lastWindow` is decided by `WindowEventCoordinator`, which asks the window registry
   * one question and spends the answer on both tiers it reclaims (this agent and the
   * app's sub-agents). Asked here as well it would be a second copy of a subtle
   * predicate — the registry, not `activeWindows`, and scoped to this monitor — free to
   * drift from the one that governs the personas.
   */
  async handleWindowClose(
    windowId: string,
    appId: string,
    monitorId?: string,
    lastWindow = false,
  ): Promise<void> {
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
      log.info('interrupting app agent — its window closed', {
        appId,
        monitorId: owner,
        windowId,
      });
      await agent.session.interrupt();
    }

    // The app is idle when its *turn* has unwound, not when the provider has stopped.
    // `interrupt()` returns as soon as the model is no longer producing; the turn is
    // still inside `AgentSession.handleMessage`'s `finally` and inside `handleAppTask`'s,
    // and that second `finally` is what clears the flag below and drains the queue.
    //
    // Clearing it here instead was a race with a very specific victim: the monitor agent
    // closing an app window and re-invoking the app in the same breath. The re-invoke
    // found the app "idle", started a second turn on the same `AgentSession`, and the
    // dying first turn's `finally` then cleared `running` under it — so the new turn's
    // read loop broke at its first message and the user's re-invoked window never
    // rendered, while the *interrupted* turn, resurrected by the new one's `running`,
    // delivered the answer the close was supposed to cancel.
    //
    // So: hand the rest to the turn. Its own `finally` retires the agent if we ask, then
    // clears the flag, then drains — and anything arriving meanwhile queues behind it
    // (bounded and refused out loud by `enqueueOrReject`) rather than racing any of it.
    // Only a key with no turn behind it is finished here — a flag set by a task that
    // never reached one.
    const turn = this.inflight.get(processingKey);
    if (turn) {
      if (lastWindow) this.pendingRelease.add(processingKey);
      await turn;
    } else {
      if (lastWindow) await this.releaseAgent(owner, appId);
      this.ctx.windowQueuePolicy.setProcessing(processingKey, false);
    }

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
    // Bookkeeping only — each entry's resolver is held by its own turn's `finally`, so
    // a close already waiting on one is released by the turn, not by this map.
    this.inflight.clear();
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

  /**
   * Hand the next queued task to the agent that just went idle.
   *
   * A task whose window disappeared while it waited cannot run — but it used to be
   * dequeued and dropped in silence, *and* it took the rest of the queue with it, since
   * nothing else drains this. The sender was left holding a message the server had
   * acknowledged with `MESSAGE_QUEUED` and would never answer; for a monitor agent
   * waiting on `hook: 'response'`, that is a turn that simply never comes back. The
   * same sentence `handleWindowClose` uses, then, and keep draining until something is
   * actually runnable.
   */
  private async processQueue(processingKey: string): Promise<void> {
    for (;;) {
      const next = this.ctx.windowQueuePolicy.dequeue(processingKey);
      if (!next) return;

      const appId = next.task.windowId
        ? this.ctx.windowState.getAppIdForWindow(next.task.windowId)
        : undefined;
      if (appId) {
        await this.handleAppTask(next.task, appId);
        return;
      }

      await this.ctx.sendEvent({
        type: ServerEventType.ERROR,
        error: `Message dropped: window ${next.task.windowId ?? '(unknown)'} was closed before it ran.`,
        messageId: next.task.messageId,
        ...(next.task.monitorId ? { monitorId: next.task.monitorId } : {}),
      });
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
