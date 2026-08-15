/**
 * WindowEventCoordinator — window/app event fan-out and window-scoped cleanup.
 *
 * Owns the *event* half of window state, which `ContextPool` used to implement inline:
 * subscription key normalization, change notifications, app-channel delivery, the
 * per-window app-event rate cap, and the teardown that runs when a window closes.
 *
 * It composes `WindowSubscriptionPolicy` (the subscription table) and `AppTaskProcessor`
 * (the app agent that owns a window). It is not an agent registry: it never creates or
 * disposes agents, and it reaches the pool's task routing only through the `deliver`
 * callback handed to it, so notification delivery keeps going through the one entry
 * point that applies the reset guard and inflight accounting.
 */

import { frameAppEvent, type WindowChangeEvent } from './context-pool-policies/index.js';
import type { AppTaskProcessor } from './app-task-processor.js';
import type { WindowEventPoolContext, Task } from './pool-types.js';
import { createLogger } from '../observability/log.js';

const log = createLogger('WindowEventCoordinator');

/** Per-window app-event rate cap: emits beyond this within the window are dropped. */
const APP_EVENT_RATE_LIMIT = 20;
const APP_EVENT_RATE_WINDOW_MS = 1000;

export class WindowEventCoordinator {
  /** Per-window app-event rate tracking: windowKey → { count, windowStart }. */
  private appEventRate = new Map<
    string,
    { count: number; windowStart: number; warned?: boolean }
  >();

  constructor(
    private readonly ctx: WindowEventPoolContext,
    private readonly appProcessor: AppTaskProcessor,
    /** Route a notification task back through the pool's single task entry point. */
    private readonly deliver: (task: Task) => void,
  ) {}

  /**
   * The monitor-scoped key a subscription is indexed under.
   *
   * Subscriptions are keyed by window, and callers hand us a mix: an agent's raw
   * AI-facing id ("ai-chat") from a verb, or the frontend's scoped key ("1/ai-chat")
   * from a client event. A raw id names one window *per monitor*, so indexing on it
   * would let monitor 0's subscription match an event emitted by monitor 1's copy of
   * the same app. Both ends of the channel — subscribe and notify — normalize here.
   */
  private windowKey(windowId: string): string {
    return this.ctx.windowState.getWindow(windowId)?.id ?? windowId;
  }

  notifyWindowSubscribers(
    windowId: string,
    event: WindowChangeEvent,
    summary: string,
    sourceAgentKey?: string,
  ): void {
    const key = this.windowKey(windowId);
    this.ctx.windowSubscriptionPolicy.notifyChange(key, event, summary, sourceAgentKey, (task) => {
      this.deliver(task);
    });
  }

  /**
   * Deliver an app event (`app.emit(channel, payload)`) to subscribed agents.
   *
   * Matches channel subscribers and either wakes them (`wake` mode → task) or
   * buffers the framed event into their next turn (`buffer` mode → timeline).
   * Rate-capped per window; emits with no subscribers are dropped silently.
   *
   * `opts.wakeAgent` adds one more recipient the subscription table cannot
   * express: the emitting app's **own** agent (see {@link wakeOwnAppAgent}).
   * It is checked inside the rate cap, so a chatty app cannot use it to bypass
   * the limit its subscribers are held to.
   */
  notifyAppChannel(
    windowId: string,
    channel: string,
    payload: unknown,
    sourceAgentKey?: string,
    opts?: { wakeAgent?: boolean },
  ): void {
    const key = this.windowKey(windowId);
    if (this.isAppEventRateLimited(key)) {
      // A chatty app trips the limit on nearly every emit; warning per drop buries
      // everything else in the log. One line per rate window says the same thing.
      const entry = this.appEventRate.get(key);
      if (entry && !entry.warned) {
        entry.warned = true;
        log.warn('app event rate limit hit — dropping until the window resets', { key, channel });
      }
      return;
    }

    this.ctx.windowSubscriptionPolicy.notifyChannel(
      key,
      channel,
      payload,
      sourceAgentKey,
      (task) => {
        this.deliver(task);
      },
      (sub, framedContent) => {
        // Buffer mode: drain into the agent's next turn without waking it — on the
        // subscriber's own monitor, so another desktop's turn cannot swallow it.
        this.ctx.timelineFor(sub.subscriberMonitorId).pushRaw(framedContent);
      },
    );

    if (opts?.wakeAgent) this.wakeOwnAppAgent(key, channel, payload);
  }

  /**
   * Wake the emitting app's own agent with the event.
   *
   * The gap this fills: an app agent holds four tools and none of them is a verb,
   * so it cannot subscribe to anything — and the one recipient an app most often
   * wants is its own agent, waiting on work it started and stopped blocking for.
   * The app says so at the emit (`app.emit(ch, payload, { wakeAgent: true })`),
   * because only the iframe knows whether the agent asked for this: the same
   * event raised by a user clicking a button in the app's own UI must wake
   * nobody.
   *
   * **An existing agent only.** Delivery would otherwise route through
   * `AppTaskProcessor`, which creates the app agent on demand — so an app that
   * emitted while its agent was retired would spawn one to tell it about work it
   * never asked for, and pay a model turn for it. With no agent running there is
   * nothing to wake and the emit is an ordinary one.
   */
  private wakeOwnAppAgent(windowKey: string, channel: string, payload: unknown): void {
    const appId = this.ctx.windowState.getAppIdForWindow(windowKey);
    const monitorId = this.ctx.windowState.getMonitorForWindow(windowKey);
    if (!appId || !monitorId) return;
    if (!this.ctx.agentPool.hasAppAgent(monitorId, appId)) {
      log.debug('wakeAgent emit dropped — no app agent running', { appId, monitorId, channel });
      return;
    }
    this.deliver({
      requestedType: 'app',
      kind: 'notify',
      messageId: `app-wake-${windowKey}-${channel}-${Date.now()}`,
      windowId: windowKey,
      content: frameAppEvent(windowKey, channel, payload),
      monitorId,
    });
  }

  /** True when the window has exceeded its app-event rate cap in the current window. */
  private isAppEventRateLimited(windowKey: string): boolean {
    const now = Date.now();
    const entry = this.appEventRate.get(windowKey);
    if (!entry || now - entry.windowStart >= APP_EVENT_RATE_WINDOW_MS) {
      this.appEventRate.set(windowKey, { count: 1, windowStart: now });
      return false;
    }
    entry.count++;
    return entry.count > APP_EVENT_RATE_LIMIT;
  }

  handleWindowClose(windowId: string, appId?: string, monitorId?: string): void {
    // Clean up subscriptions and prune context for this window. Subscriptions are
    // indexed by the scoped key (see windowKey), so clear under that — clearing by a
    // raw id would leave this window's subscriptions live and, worse, could drop the
    // same-named window on another monitor.
    const key = this.windowKey(windowId);
    this.ctx.windowSubscriptionPolicy.clearForWindow(key);
    this.ctx.contextTape.pruneWindow(windowId);
    this.appEventRate.delete(key);

    // If this window belongs to an app, interrupt the running agent and clear its queue —
    // and if the app has just left this desktop, reclaim both tiers it owns here.
    //
    // One question, asked once. Both reclaims turn on "is the app still on this monitor",
    // and both used to be free to answer it their own way; asking here and spending the
    // answer twice is what keeps the app agent and its personas from disagreeing about
    // whether the app is gone.
    if (appId) {
      const lastWindow = this.isLastWindowForApp(appId, monitorId);
      this.appProcessor.handleWindowClose(windowId, appId, monitorId, lastWindow).catch((err) => {
        log.error('tearing down app agent on window close failed', { appId, windowId, err });
      });
      if (lastWindow) this.disposePersonas(appId, monitorId!);
    }
  }

  /**
   * Whether the app has no windows left on this monitor.
   *
   * Asked of the window registry rather than the app processor's `activeWindows`, which
   * tracks the most-recently-active window per app and is cleared by the close above —
   * reading it here would report "no windows left" while a second window of the same app
   * is still open.
   *
   * Without a monitor there is no question to answer: the reclaims below are per-monitor
   * (the same app on another desktop is a different agent), so an unscoped close reclaims
   * nothing rather than guessing.
   */
  private isLastWindowForApp(appId: string, monitorId?: string): boolean {
    if (!monitorId) return false;
    return !this.ctx.windowState
      .listWindows()
      .some(
        (w) => w.appId === appId && this.ctx.windowState.getMonitorForWindow(w.id) === monitorId,
      );
  }

  /**
   * Reclaim an app's personas, its last window on this monitor having just closed.
   *
   * Their operator goes at the same moment and on the same condition (see
   * `AppTaskProcessor.handleWindowClose`), but the two are still separate calls rather
   * than one cascade, because the ownership is genuinely separate: a persona's owner is
   * the (monitor, app) pair, not the app agent — the iframe spawns them, and they exist
   * whether or not an app agent ever did. Retiring the operator for any *other* reason
   * (`fresh: true`, the idle reaper) deliberately leaves the cast standing.
   *
   * What makes reclaiming them here non-negotiable is the arithmetic: a room of four
   * holds four slots out of the global `MAX_AGENTS` semaphore, and an app that is no
   * longer on screen holding almost half the machine's agents starves everything else.
   * The app persists what it needs (appDb/appStorage) and replays it into a respawned
   * persona's first message, which is the recovery path the ChitChats port was designed
   * around anyway.
   */
  private disposePersonas(appId: string, monitorId: string): void {
    this.ctx.agentPool.subAgents.disposeForApp(monitorId, appId).catch((err: unknown) => {
      log.error('disposing personas failed', { appId, monitorId, err });
    });
  }

  /**
   * Resolve the most recently active window for an app on a monitor (used by
   * DirectMessage and cross-app control routing). Scoped to the monitor so a
   * caller on monitor 1 can never reach into monitor 0's copy of the app.
   */
  getActiveAppWindow(monitorId: string, appId: string): string | undefined {
    return this.appProcessor.getActiveWindowId(monitorId, appId);
  }

  /**
   * Find the windowId for a given agent instanceId. Only app agents own a window.
   */
  findWindowForAgent(agentId: string): string | undefined {
    const app = this.ctx.agentPool.findAppForAgent(agentId);
    if (app) return this.appProcessor.getActiveWindowId(app.monitorId, app.appId);
    return undefined;
  }

  /** Drop all subscription and rate state (pool reset / cleanup). */
  clear(): void {
    this.ctx.windowSubscriptionPolicy.clear();
    this.appEventRate.clear();
  }
}
