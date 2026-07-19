/**
 * The session's half of the agent↔iframe conversation: which of this session's app windows
 * have a live document behind them, what reaches them, and what has to be re-sent when one
 * of them comes back.
 *
 * The request/response lifecycle itself is not here — a pending app-protocol request is
 * owned by the `ActionEmitter`'s pending store, keyed by request id, and settles wherever
 * the answer arrives. What *is* here is everything that depends on being a particular
 * session looking at a particular window: readiness, replay, and channel routing.
 *
 * Readiness is deliberately per (session, window key) and not per app. Two browsers showing
 * the same app on the same monitor share a window key, but each has its own document, and
 * only one of them has said it registered.
 */

import { BRIDGE_APP_ID, ServerEventType, type ServerEvent } from '@yaar/shared';
import type { ClientEventType } from '@yaar/shared';
import type { ClientEventOf } from './client-event-router.js';
import type { AppProtocolRequestData } from './emitter-channels.js';
import type { SessionId } from './types.js';
import type { WindowStateRegistry } from './window-state.js';
import { actionEmitter } from './action-emitter.js';
import { recordEmit } from '../features/window/protocol-log.js';

/** The pool operations this coordinator needs, narrowed so `ContextPool` stays out. */
export interface AppChannelTarget {
  notifyAppChannel(windowId: string, channel: string, payload: unknown): void;
}

export interface AppWindowCoordinatorDeps {
  sessionId: SessionId;
  windowState: WindowStateRegistry;
  broadcast(event: ServerEvent): void;
  /** Lazy — the pool does not exist until the first message that needs it. */
  getPool(): AppChannelTarget | null;
}

export class AppWindowCoordinator {
  constructor(private readonly deps: AppWindowCoordinatorDeps) {}

  /** A tool asking an iframe app something — relayed to the frontend that hosts it. */
  handleProtocolRequest(data: AppProtocolRequestData): void {
    this.deps.broadcast({
      type: ServerEventType.APP_PROTOCOL_REQUEST,
      requestId: data.requestId,
      windowId: data.windowId,
      request: data.request,
      timeoutMs: data.timeoutMs,
    });
  }

  /** An iframe reporting that its app has registered and can be commanded. */
  handleReady(event: ClientEventOf<typeof ClientEventType.APP_PROTOCOL_READY>): void {
    // The frontend reports the monitor-scoped key (e.g. "0/ai-chat", from the window
    // element's data-window-id). Keep that scope: readiness is per window, and the raw
    // AI-facing id ("ai-chat") names one window *per monitor*, so collapsing to it would
    // let monitor 0's registration mark monitor 1's window ready — leaving monitor 1's
    // agent talking to an iframe that never registered. app_query/app_command wait on
    // the same resolved key (see requireAppReady).
    //
    // Windows stored under a bare raw id (devtools preview windows, created via the
    // iframe-SDK proxy with no monitor) still resolve: getWindow() matches them exactly,
    // and the fallback below strips a scope they never had.
    const windowKey =
      this.deps.windowState.getWindow(event.windowId)?.id ??
      this.deps.windowState.handleMap.getRawWindowId(event.windowId);
    const wasReady = this.deps.windowState.getWindow(windowKey)?.appProtocol ?? false;
    this.deps.windowState.setAppProtocol(windowKey);
    // Readiness is this session's fact about this session's iframe — a second browser
    // showing the same app on the same monitor has the same window key and a document
    // that has said nothing.
    actionEmitter.notifyAppReady(this.deps.sessionId, windowKey);
    // Replay stored commands only on re-registration (reload/remount), not first time —
    // and never on a re-announce, where the desktop is repeating a registration it
    // already witnessed and the iframe never remounted (see AppProtocolReadyEvent).
    if (wasReady && !event.reannounce) {
      this.replayCommands(windowKey);
    }
  }

  /**
   * The window's iframe is gone. Reopening the app under the same key mounts a new
   * document, which must register again before anything is commanded to it.
   */
  forgetReady(windowId: string): void {
    actionEmitter.forgetAppReady(this.deps.sessionId, windowId);
  }

  /** An app emitted on a declared channel. */
  handleAppEvent(event: ClientEventOf<typeof ClientEventType.APP_EVENT>): void {
    // Pass the monitor-scoped window key (from the iframe element's data-window-id)
    // through as-is — ContextPool indexes subscriptions by that key. Collapsing it to the
    // raw AI-facing id would deliver monitor 1's app events to a subscriber watching
    // monitor 0's copy of the same app, since both windows share the raw id.
    recordEmit(event.windowId, event.channel, event.payload);
    this.deps.getPool()?.notifyAppChannel(event.windowId, event.channel, event.payload);
  }

  /**
   * Deliver an unsolicited real-browser event to this session's Real Browser windows.
   *
   * This is the server-side twin of the `APP_EVENT` client frame: both land on
   * `ContextPool.notifyAppChannel`, so channel subscriptions, debounce, the per-window rate
   * cap and the `<app:event>` framing are shared. The event does *not* detour through the
   * iframe to be re-emitted via `app.emit()` — it already arrives in canonical form, the
   * iframe would add nothing but two hops, and a window mid-reload would silently drop it.
   *
   * A session with no Real Browser window open is not an error: the channels are declared
   * on that window, so with no window there is nobody who could have subscribed. Drop it.
   */
  routeBridgeEvent(channel: string, payload: unknown): void {
    const pool = this.deps.getPool();
    if (!pool) return;

    for (const window of this.deps.windowState.listWindows()) {
      if (window.appId !== BRIDGE_APP_ID) continue;
      pool.notifyAppChannel(window.id, channel, payload);
    }
  }

  /**
   * Replay stored app commands to a window that just re-registered.
   * This restores iframe app state after reload or remount.
   */
  private replayCommands(windowId: string): void {
    const commands = this.deps.windowState.getAppCommands(windowId);
    if (commands.length === 0) return;

    console.log(
      `[AppWindowCoordinator ${this.deps.sessionId}] Replaying ${commands.length} app commands to window ${windowId}`,
    );
    for (let i = 0; i < commands.length; i++) {
      this.deps.broadcast({
        type: ServerEventType.APP_PROTOCOL_REQUEST,
        requestId: `replay-${windowId}-${Date.now()}-${i}`,
        windowId,
        request: commands[i],
      });
    }
  }
}
