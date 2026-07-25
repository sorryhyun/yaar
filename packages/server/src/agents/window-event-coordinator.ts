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

import type { WindowChangeEvent } from './context-pool-policies/index.js';
import type { AppTaskProcessor } from './app-task-processor.js';
import type { PoolContext, Task } from './pool-types.js';

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
    private readonly ctx: PoolContext,
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
   */
  notifyAppChannel(
    windowId: string,
    channel: string,
    payload: unknown,
    sourceAgentKey?: string,
  ): void {
    const key = this.windowKey(windowId);
    if (this.isAppEventRateLimited(key)) {
      // A chatty app trips the limit on nearly every emit; warning per drop buries
      // everything else in the log. One line per rate window says the same thing.
      const entry = this.appEventRate.get(key);
      if (entry && !entry.warned) {
        entry.warned = true;
        console.warn(
          `[WindowEventCoordinator] App event rate limit hit for window "${key}" (channel "${channel}") — dropping until the window resets.`,
        );
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
      (_sub, framedContent) => {
        // Buffer mode: drain into the agent's next turn without waking it.
        this.ctx.timeline.pushRaw(framedContent);
      },
    );
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

    // If this window belongs to an app, interrupt the running agent and clear its queue
    if (appId) {
      this.appProcessor.handleWindowClose(windowId, appId, monitorId).catch((err) => {
        console.error(
          `[WindowEventCoordinator] Error interrupting app agent on window close:`,
          err,
        );
      });
      this.disposePersonasIfLastWindow(appId, monitorId);
    }
  }

  /**
   * Reclaim an app's personas once its last window on this monitor is gone.
   *
   * App agents survive a window close — the next window reuses the agent and its
   * context, which is the behavior a user feels as the app remembering them. Personas
   * cannot follow that rule: a room of four holds four slots out of the global
   * `MAX_AGENTS` semaphore, and an app that is no longer on screen holding almost
   * half the machine's agents starves everything else. The app persists what it needs
   * (appDb/appStorage) and replays it into a respawned persona's first message, which
   * is the recovery path the ChitChats port was designed around anyway.
   *
   * "Last window" is asked of the window registry rather than the app processor's
   * `activeWindows`, which tracks the most-recently-active window per app and is
   * cleared by the close above — reading it here would report "no windows left" while
   * a second window of the same app is still open.
   */
  private disposePersonasIfLastWindow(appId: string, monitorId?: string): void {
    if (!monitorId) return;
    const stillOpen = this.ctx.windowState
      .listWindows()
      .some(
        (w) => w.appId === appId && this.ctx.windowState.getMonitorForWindow(w.id) === monitorId,
      );
    if (stillOpen) return;

    this.ctx.agentPool.disposePersonasForApp(monitorId, appId).catch((err) => {
      console.error(`[WindowEventCoordinator] Error disposing personas for ${appId}:`, err);
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
