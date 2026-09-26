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
import type { AppPoolContext, QueuedTask, Task } from './pool-types.js';
import type { AgentProfile } from './profiles/types.js';
import { buildAppAgentProfile, turnOptionsFor } from './profiles/index.js';
import { buildReloadContext, runAgentTurn } from './turn-helpers.js';
import { windowSource, monitorSource } from './context.js';
import { appRolePrefix, monitorRole } from './roles.js';
import { appAgentKey } from './agent-roster.js';
import { enqueueOrReject } from './queue-refusal.js';
import {
  AppStateHandoffStore,
  formatAppStateHandoffNotice,
  formatContextLostNotice,
  type ContextLostReason,
} from './app-state-handoff.js';
import { captureDeclaredAppState } from '../features/window/app-protocol.js';
import { MAX_QUEUE_SIZE } from '../config.js';
import { createLogger } from '../observability/log.js';

const log = createLogger('AppTaskProcessor');

/**
 * Everything this class tracks about one app on one monitor, keyed by {@link appAgentKey}.
 *
 * One record rather than a map per field, because the fields used to be six maps under
 * two spellings of the same (monitor, app) pair — this key, and a queue key of its own
 * that `WindowQueuePolicy` filed the queue and the is-processing flag under — and each
 * teardown path cleared a different subset: `clearMonitor` reached two of the six, and
 * the processing flags were never deleted at all. A slot goes in one `delete`.
 */
interface AppSlot {
  /**
   * Main turns waiting for the running one. Bounded, on the same limit as a monitor's
   * queue: unbounded, an app agent wedged mid-turn (a provider that never returns, an
   * iframe that never answers) collected every later click in that window with no
   * ceiling and no refusal. The refusal goes through `enqueueOrReject`.
   */
  queue: QueuedTask[];
  /**
   * The main turn running now, if any — its presence *is* "the app is busy". Resolves,
   * never rejects, once `handleAppTask`'s `finally` has begun, so a window close can wait
   * the turn out instead of racing it. See {@link AppTaskProcessor.handleWindowClose}.
   *
   * Only main turns are tracked; a parallel (`actionId`) task never set this and never
   * blocked one. `AgentSession` serializes those against the main turn on its own.
   *
   * Cleared at the very end of the turn's teardown, after any pending release — not
   * before it. The busy flag and the waitable turn used to be two maps, emptied at two
   * different moments, and a close landing between them (while the teardown was still
   * retiring the agent) found a busy app with no turn to wait for, cleared the flag
   * itself, and let the next message start a turn beside the drain.
   */
  turn?: Promise<void>;
  /**
   * The agent must be retired the moment its turn stops.
   *
   * A close that lands mid-turn cannot dispose the agent where it stands — the turn is
   * still running on it — and it cannot dispose it after `await`ing the turn either,
   * because by then the turn's own `finally` has already drained the queue onto that
   * same agent. So the close leaves the request here and the turn's teardown honours it,
   * inside the processing lock, between the last message and the first queued one.
   */
  pendingRelease: boolean;
  /** The most recently interacted window (for tool resolution). */
  activeWindow?: string;
  /**
   * Why the agent was reclaimed without the app tier asking, until the successor's first
   * turn has been told.
   *
   * Per (monitor, app) rather than per window because that is what an app agent is: one
   * window closing and another opening is the same agent, and the successor owes the
   * notice to whichever window speaks to it first.
   */
  contextLost?: ContextLostReason;
}

export class AppTaskProcessor {
  private slots = new Map<string, AppSlot>();
  /** Cached agent profiles per appId (a profile depends only on the app). */
  private profiles = new Map<string, AgentProfile>();
  /** Fingerprints captured immediately before an app agent is released. */
  private handoffState = new AppStateHandoffStore();

  constructor(private readonly ctx: AppPoolContext) {
    // Every per-app reclamation, including the ones no app task caused — see
    // `releaseAgent` for why the fingerprints cannot outlive the agent that made them.
    // `monitor-closed` is not one of them: the monitor takes every window with it, so
    // `clearMonitor` drops the whole monitor's fingerprints in one call, and there is no
    // successor on a monitor that no longer exists to hand a notice to.
    this.ctx.agentPool.appAgents.onReclaimed((monitorId, appId, reason) => {
      if (reason === 'monitor-closed') return;
      this.forgetHandoffState(monitorId, appId);
      if (reason !== 'release') this.slot(monitorId, appId).contextLost = reason;
    });
  }

  private slot(monitorId: string, appId: string): AppSlot {
    const key = appAgentKey(monitorId, appId);
    let slot = this.slots.get(key);
    if (!slot) {
      slot = { queue: [], pendingRelease: false };
      this.slots.set(key, slot);
    }
    return slot;
  }

  /** Drop a slot that no longer holds anything, so a closed app leaves nothing behind. */
  private pruneSlot(monitorId: string, appId: string): void {
    const key = appAgentKey(monitorId, appId);
    const slot = this.slots.get(key);
    if (
      slot &&
      slot.queue.length === 0 &&
      !slot.turn &&
      !slot.pendingRelease &&
      !slot.activeWindow &&
      !slot.contextLost
    ) {
      this.slots.delete(key);
    }
  }

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
    // the active window, the context tape's window source, and the reload fingerprint
    // across two spellings of one window.
    const windowId =
      this.ctx.windowState.handleMap.resolve(task.windowId, monitorId) ?? task.windowId;

    const slot = this.slot(monitorId, appId);
    slot.activeWindow = windowId;

    const isParallel = !!task.actionId;

    // If the app agent is already busy, try to steer (inject mid-turn message).
    // Falls back to queuing if the provider doesn't support steering.
    //
    // A `fresh` task never steers: steering injects it into the very turn — and the
    // very memory — it asked not to be answered from. It queues instead, and the
    // release happens when it reaches the front. Deliberately not an interrupt: the
    // flag says the *next* request needs no history, not that the running one should
    // be abandoned.
    if (!isParallel && slot.turn) {
      const steered =
        !task.fresh && (await this.ctx.agentPool.appAgents.steer(monitorId, appId, task.content));
      if (steered) {
        log.info('steered task into running app agent', { messageId: task.messageId, appId });
        const source = windowSource(windowId);
        this.ctx.contextAssembly.appendUserMessage(this.ctx.contextTape, task.content, source);
        await this.ctx.sendEvent({
          type: ServerEventType.MESSAGE_ACCEPTED,
          messageId: task.messageId,
          agentId:
            this.ctx.agentPool.appAgents.get(monitorId, appId)?.currentRole ??
            appRolePrefix(monitorId, appId),
        });
        return;
      }

      // Fallback: queue if steering not supported (e.g. Codex provider). Bounded, and
      // refused out loud when the bound is reached — a wedged app agent used to collect
      // clicks forever, and the user's only clue was a chip that never moved.
      await enqueueOrReject({
        sendEvent: (event) => this.ctx.sendEvent(event),
        queue: {
          canEnqueue: () => slot.queue.length < MAX_QUEUE_SIZE,
          enqueue: () => slot.queue.push({ task, timestamp: Date.now() }),
        },
        task,
        monitorId,
        maxQueueSize: MAX_QUEUE_SIZE,
        why: 'Please wait for current operations to complete.',
        onQueued: (position) =>
          log.info('queued app task', { messageId: task.messageId, appId, monitorId, position }),
      });
      return;
    }

    // `slot.turn` is the main turn's alone. A parallel (`actionId`) task neither checks it
    // above nor owns it here: one that set and cleared it would, finishing mid-turn,
    // mark the app idle under a main turn still running — and the next message would
    // start a second main turn on the same agent.
    let settleTurn: () => void = () => {};
    if (!isParallel) {
      slot.turn = new Promise<void>((resolve) => {
        settleTurn = resolve;
      });
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

      const agent = await this.ctx.agentPool.appAgents.getOrCreate(monitorId, appId);
      if (!agent) {
        log.error('failed to create app agent', { appId, monitorId });
        await this.ctx.sendEvent({
          type: ServerEventType.ERROR,
          error: `Failed to create agent for app ${appId}`,
        });
        // The flag, the settle and the drain are all the `finally`'s below.
        return;
      }

      let profile = this.profiles.get(appId);
      if (!profile) {
        profile = await buildAppAgentProfile(appId);
        this.profiles.set(appId, profile);
      }

      const stateKeys = profile.appStateKeys ?? [];
      // Order matters: the loss of the predecessor is the frame the rest of the turn is
      // read in, so it goes first. `takeContextLostNotice` is a take — one successor is
      // told once, and a turn that never reaches here keeps the mark for the next.
      const notices = [
        this.takeContextLostNotice(monitorId, appId),
        await this.buildHandoffNotice(windowId, stateKeys),
      ].filter(Boolean);
      const prompt =
        notices.length > 0 ? `${notices.join('\n\n')}\n\n${task.content}` : task.content;

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
        appId,
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
          const logger = this.ctx.getSessionLogger();
          await logger?.registerAgent(agentRole, monitorRole(monitorId), windowId);
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
      settleTurn();
      // Everything below is the main turn's teardown. A parallel task that ran it would
      // clear the busy mark under a main turn still running, or honour a close's pending
      // release by disposing the agent that turn is standing on.
      if (!isParallel) {
        // A close that landed mid-turn asked for this agent to be retired. Here, and not
        // where the close ran: this is inside the processing lock and ahead of the drain,
        // so the queued messages below are answered by the *replacement* agent rather
        // than starting a turn on one that is about to be disposed underneath them. A
        // loop, because the app still reads as busy while the release runs, so a close
        // arriving during it leaves its request here too.
        while (slot.pendingRelease) {
          slot.pendingRelease = false;
          await this.releaseAgent(monitorId, appId);
        }
        slot.turn = undefined;
        await this.processQueue(slot);
      }
    }
  }

  /**
   * Retire one app's agent on one monitor so the next turn starts from nothing.
   *
   * The agent's memory lives in its provider session, which `appAgents.dispose` ends —
   * the context tape is a log, and nothing reads it back into a prompt, so there is
   * no branch to prune here.
   *
   * The handoff fingerprints must go with it — see {@link forgetHandoffState}. That no
   * longer happens here: the registry announces every reclamation and this class forgets
   * on the announcement, because the two reclamations that do *not* come through here
   * (the idle reaper, and a `delete` on `yaar://agents/{app}`) left the fingerprints
   * behind, and a successor was then told `<app_state_since_handoff changed="false"/>`
   * about a handoff it had never made.
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
   * they share this and not merely a call to `appAgents.dispose`: the handoff fingerprints
   * have to go with it either way.
   */
  private async releaseAgent(monitorId: string, appId: string): Promise<void> {
    if (!this.ctx.agentPool.appAgents.has(monitorId, appId)) return;

    await this.ctx.agentPool.appAgents.dispose(monitorId, appId, 'release');
  }

  /**
   * Drop the handoff fingerprints of one app on one monitor — its agent is gone.
   *
   * Every window of the app, not just the one whose task prompted this: the dead agent
   * may have driven several, and its successor has seen none of them.
   */
  private forgetHandoffState(monitorId: string, appId: string): void {
    for (const handle of this.ctx.windowState.handleMap.listByMonitor(monitorId)) {
      if (this.ctx.windowState.getAppIdForWindow(handle) === appId) {
        this.handoffState.forget(handle);
      }
    }
  }

  /** The most recently active windowId for an app on a monitor. */
  getActiveWindowId(monitorId: string, appId: string): string | undefined {
    return this.slots.get(appAgentKey(monitorId, appId))?.activeWindow;
  }

  /**
   * A window closed: interrupt the app agent if it's running for this window, clear
   * queued tasks, remove active window tracking, and — when this was the app's last
   * window on the monitor — retire the agent along with it.
   *
   * `lastWindow` is decided by `WindowEventCoordinator`, which asks the window registry
   * one question and spends the answer on both tiers it reclaims (this agent and the
   * app's sub-agents). Asked here as well it would be a second copy of a subtle
   * predicate — the registry, not the slot's active window, and scoped to this monitor —
   * free to drift from the one that governs the personas.
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
    const slot = this.slots.get(appAgentKey(owner, appId));

    // Clear any queued tasks for this app on this monitor. Each is a click or message the
    // user made in a window that has since closed — it will not run, and saying so is the
    // difference between a cancelled action and one that appears to still be pending.
    const dropped = slot?.queue.splice(0) ?? [];
    for (const { task } of dropped) {
      await this.ctx.sendEvent({
        type: ServerEventType.ERROR,
        error: `Message dropped: window ${windowId} was closed before it ran.`,
        messageId: task.messageId,
        ...(owner ? { monitorId: owner } : {}),
      });
    }

    if (slot?.activeWindow === windowId) slot.activeWindow = undefined;

    const agent = this.ctx.agentPool.appAgents.get(owner, appId);
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
    // clears the busy mark, then drains — and anything arriving meanwhile queues behind it
    // (bounded and refused out loud by `enqueueOrReject`) rather than racing any of it.
    // With no turn running, the app is idle and the release is ours to do.
    if (slot?.turn) {
      if (lastWindow) slot.pendingRelease = true;
      await slot.turn;
    } else if (lastWindow) {
      await this.releaseAgent(owner, appId);
    }

    this.handoffState.forget(windowId);
    this.pruneSlot(owner, appId);
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

  /** Whether a main turn is running for this app on this monitor. */
  isTurnRunning(monitorId: string, appId: string): boolean {
    return !!this.slots.get(appAgentKey(monitorId, appId))?.turn;
  }

  /** Queued task counts per app agent key, for pool stats. Empty queues are omitted. */
  getQueueSizes(): Record<string, number> {
    const sizes: Record<string, number> = {};
    for (const [key, slot] of this.slots) {
      if (slot.queue.length > 0) sizes[key] = slot.queue.length;
    }
    return sizes;
  }

  /**
   * Drop every app's queued tasks and hand them back, for the caller to report. See
   * `MonitorQueuePolicy.clear()` for why they are returned rather than swallowed.
   *
   * The running turns keep their slots: each still drains its (now empty) queue and
   * clears its own busy mark on the way out.
   */
  clearQueues(): Task[] {
    const dropped: Task[] = [];
    for (const slot of this.slots.values()) {
      dropped.push(...slot.queue.splice(0).map((q) => q.task));
    }
    return dropped;
  }

  /**
   * Drop everything tracked for one monitor (its app agents are disposed with it).
   *
   * A turn still unwinding keeps its own reference to its slot, so its teardown finishes
   * against that record and cannot drain or clear a successor's.
   */
  clearMonitor(monitorId: string): void {
    const prefix = appAgentKey(monitorId, '');
    for (const key of this.slots.keys()) {
      if (key.startsWith(prefix)) this.slots.delete(key);
    }
    this.handoffState.forgetMonitor(monitorId);
  }

  disposeAll(): void {
    // Bookkeeping only — each slot's turn resolver is held by the turn's own `finally`,
    // so a close already waiting on one is released by the turn, not by this map.
    this.slots.clear();
    this.profiles.clear();
    this.handoffState.clear();
  }

  /**
   * The context-lost notice owed to this app's agent on this monitor, consumed.
   *
   * Empty whenever the incumbent is the agent that did the work — which is every
   * ordinary turn. Read after `getOrCreate`, so the mark left by a reclamation is spent
   * on the successor rather than on the reclaimed agent's own last breath.
   */
  private takeContextLostNotice(monitorId: string, appId: string): string {
    const slot = this.slots.get(appAgentKey(monitorId, appId));
    const reason = slot?.contextLost;
    if (!slot || !reason) return '';
    slot.contextLost = undefined;
    return formatContextLostNotice(reason);
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
   *
   * Takes the slot the finished turn ran under rather than looking it up again: if the
   * monitor was cleared meanwhile, a fresh slot under the same key belongs to someone else.
   */
  private async processQueue(slot: AppSlot): Promise<void> {
    for (;;) {
      const next = slot.queue.shift();
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
