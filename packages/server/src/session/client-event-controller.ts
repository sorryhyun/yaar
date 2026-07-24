/**
 * Every client frame a session answers, and the code that answers it.
 *
 * The route table lives here rather than in `LiveSession` because answering frames is one
 * job among the several that class was doing, and it is the one with the most handlers and
 * the least to do with owning a session's lifetime. `LiveSession` still decides *whether* a
 * frame is dispatched at all — it initializes the pool and settles message-id acceptance
 * first — and remains the public entry point (`routeMessage`).
 *
 * The table is total by construction (see `client-event-router.ts`), so a new frame type in
 * `@yaar/shared` is a compile error here rather than a frame silently dropped at runtime.
 *
 * Collaborators arrive as one dependency object of narrow functions and registries. The
 * pool is fetched lazily on every use, not captured once, because it does not exist until
 * the first message that needs it and is replaced wholesale by a reset.
 */

import {
  ClientEventType,
  ServerEventType,
  type ServerEvent,
  type UserInteraction,
} from '@yaar/shared';
import type { ContextPool } from '../agents/context-pool.js';
import type { SessionLogger } from '../logging/index.js';
import type { ConnectionId } from './broadcast-center.js';
import type { ClientEventOf, ClientEventRoutes } from './client-event-router.js';
import type { AppWindowCoordinator } from './app-window-coordinator.js';
import type { MonitorRegistry } from './monitor-registry.js';
import type { SessionSnapshotService } from './session-snapshot-service.js';
import type { SurfaceRegistry } from './surface-state.js';
import type { WindowStateRegistry } from './window-state.js';
import type { ReloadCache } from '../reload/cache.js';
import { actionEmitter } from './action-emitter.js';
import { genId } from '../lib/ids.js';
import { subscriptionRegistry } from '../http/subscriptions.js';
import { getAppMeta } from '../features/apps/discovery.js';
import type { SessionId } from './types.js';

export interface ClientEventDeps {
  sessionId: SessionId;
  windowState: WindowStateRegistry;
  surfaces: SurfaceRegistry;
  reloadCache: ReloadCache;
  monitors: MonitorRegistry;
  appWindows: AppWindowCoordinator;
  snapshots: SessionSnapshotService;
  /** Lazy — the pool does not exist until the first message that needs it. */
  getPool(): ContextPool | null;
  getSessionLogger(): SessionLogger | null;
  /** The session-wide gateway. See `LiveSession.broadcast`. */
  broadcast(event: ServerEvent): void;
  /** Delivery to one connection. */
  sendTo(connectionId: ConnectionId, event: ServerEvent): void;
  /**
   * Take responsibility for a message id, or report that the session already had.
   * Acceptance is the session's to decide, not a handler's — see `LiveSession`.
   */
  claimMessageId(messageId: string): boolean;
  /** Clear conversation state and re-run launch hooks. Owned by the session. */
  resetSession(connectionId: ConnectionId): Promise<void>;
  /** Close every browser session this host holds — headless sandbox and real Chrome. */
  closeBrowsers(): void;
}

export class ClientEventController {
  constructor(private readonly deps: ClientEventDeps) {}

  /**
   * Every client frame this session answers, and the method that answers it.
   *
   * A frame's presence here is the whole statement that the server handles it, and
   * `ClientEventRoutes` is total, so a new frame type cannot be added without one. A frame
   * that is *not* a `ClientEvent` (malformed, or from a newer client) still falls through
   * the router untouched, as it did before.
   */
  routes(): ClientEventRoutes {
    return {
      [ClientEventType.RESYNC]: (_event, connectionId) => this.sendSnapshot(connectionId),
      [ClientEventType.USER_MESSAGE]: (event, connectionId) =>
        this.handleUserMessage(event, connectionId),
      [ClientEventType.WINDOW_MESSAGE]: (event) => this.handleWindowMessage(event),
      [ClientEventType.APP_INTERACTION]: (event) => this.handleAppInteraction(event),
      [ClientEventType.COMPONENT_ACTION]: (event) => this.handleComponentAction(event),
      [ClientEventType.INTERRUPT]: () => this.deps.getPool()?.interruptAll(),
      [ClientEventType.RESET]: (_event, connectionId) => this.deps.resetSession(connectionId),
      [ClientEventType.INTERRUPT_AGENT]: (event) =>
        this.deps.getPool()?.interruptAgent(event.agentId),
      [ClientEventType.SET_PROVIDER]: (event) =>
        this.deps.getPool()?.getPrimaryAgent()?.setProvider(event.provider),
      [ClientEventType.RENDERING_FEEDBACK]: (event) => this.handleRenderingFeedback(event),
      [ClientEventType.DIALOG_FEEDBACK]: (event) => this.handleDialogFeedback(event),
      [ClientEventType.APP_PROTOCOL_RESPONSE]: (event) =>
        actionEmitter.resolveAppProtocolResponse(event.requestId, event.response),
      [ClientEventType.APP_PROTOCOL_READY]: (event) => this.deps.appWindows.handleReady(event),
      [ClientEventType.APP_EVENT]: (event) => this.deps.appWindows.handleAppEvent(event),
      [ClientEventType.TOAST_ACTION]: (event) => this.handleToastAction(event),
      [ClientEventType.USER_PROMPT_RESPONSE]: (event) => this.handleUserPromptResponse(event),
      [ClientEventType.USER_INTERACTION]: (event) => this.handleUserInteraction(event),
      [ClientEventType.SUBSCRIBE_MONITOR]: (event, connectionId) =>
        this.deps.monitors.subscribe(connectionId, event.monitorId, event.viewport),
      [ClientEventType.ADD_MONITOR]: (_event, connectionId) => this.deps.monitors.add(connectionId),
      [ClientEventType.REMOVE_MONITOR]: (event) => this.deps.monitors.remove(event.monitorId),
    };
  }

  /** Send the authoritative state of this session to one connection. */
  private async sendSnapshot(connectionId: ConnectionId): Promise<void> {
    const { actions, agents } = await this.deps.snapshots.build();
    this.deps.sendTo(connectionId, { type: ServerEventType.SNAPSHOT, actions, agents });
  }

  /**
   * Tell the user that the thing they just answered had already stopped listening.
   *
   * A dialog or prompt whose deadline passed is taken off the screen, but a click can
   * already be in flight when it goes — and the server has no id to match it to any more.
   * That click used to be dropped without a word, which reads, from the user's side, as
   * the system ignoring them.
   */
  private notifyTooLate(message: string): void {
    this.deps.broadcast({
      type: ServerEventType.ACTIONS,
      actions: [
        {
          type: 'toast.show',
          id: `too-late-${Date.now()}`,
          message,
          variant: 'warning',
        },
      ],
      agentId: 'system',
    } as ServerEvent);
  }

  private async handleUserMessage(
    event: ClientEventOf<typeof ClientEventType.USER_MESSAGE>,
    connectionId: ConnectionId,
  ): Promise<void> {
    // A user message's monitor comes from the connection that sent it. The client
    // always knows which monitor it is on, so `?? '0'` only ever fired when
    // something upstream had lost it — and then answered with the wrong monitor
    // rather than saying so.
    const monitorId = event.monitorId;
    if (!monitorId) {
      this.deps.sendTo(connectionId, {
        type: ServerEventType.ERROR,
        error: 'Message rejected: no monitor. A user message must name the monitor it came from.',
        messageId: event.messageId,
      });
      return;
    }
    if (!this.deps.monitors.has(monitorId)) {
      this.deps.sendTo(connectionId, {
        type: ServerEventType.ERROR,
        error: `Message rejected: monitor ${monitorId} does not exist in this session.`,
        messageId: event.messageId,
        monitorId,
      });
      return;
    }
    // A resend from the client's outbox for a message we already took. Ack it again so
    // the outbox lets go, and do not run it twice.
    if (!this.deps.claimMessageId(event.messageId)) {
      this.deps.sendTo(connectionId, {
        type: ServerEventType.MESSAGE_ACCEPTED,
        messageId: event.messageId,
        agentId: 'duplicate',
      });
      return;
    }

    // "Act as me" target (CLI-panel toggle): route to the session agent — the
    // user's deputy, the one principal that can drive the real browser.
    if (event.target === 'session') {
      await this.deps.getPool()?.handleSessionTask({
        type: 'session',
        messageId: event.messageId,
        content: event.content,
        interactions: event.interactions,
        monitorId,
      });
      return;
    }
    // The monitor exists (checked above); its agent is created on first use.
    const pool = this.deps.getPool();
    if (pool && !pool.hasMonitorAgent(monitorId)) {
      await pool.createMonitorAgent(monitorId);
    }
    // Re-read rather than reusing `pool`: a session eviction can complete during the await
    // above, and the answer to "is there a pool" is whatever it is *now*. The optional
    // chain is the guard, and it only guards if it reads the current value.
    //
    // Holding the stale reference is not harmless. `ContextPool.handleTask` rejects work
    // only while `resetting` is true, and `cleanup()` flips that back to false before
    // `LiveSession` nulls `this.pool` — so a task landing on a torn-down pool passes the
    // guard and queues against disposed state. Reading fresh is what makes the null the
    // one that stops it.
    await this.deps.getPool()?.handleTask({
      type: 'monitor',
      messageId: event.messageId,
      content: event.content,
      interactions: event.interactions,
      monitorId,
    });
  }

  private async handleWindowMessage(
    event: ClientEventOf<typeof ClientEventType.WINDOW_MESSAGE>,
  ): Promise<void> {
    await this.deps.getPool()?.handleTask({
      type: 'app',
      messageId: event.messageId,
      windowId: event.windowId,
      content: event.content,
    });
  }

  /** App interactions use the normal app task path: invoke when idle, steer when active. */
  private async handleAppInteraction(
    event: ClientEventOf<typeof ClientEventType.APP_INTERACTION>,
  ): Promise<void> {
    await this.deps.getPool()?.handleTask({
      type: 'app',
      messageId: event.messageId,
      windowId: event.windowId,
      content: event.content,
    });
  }

  private async handleComponentAction(
    event: ClientEventOf<typeof ClientEventType.COMPONENT_ACTION>,
  ): Promise<void> {
    const windowContext = event.windowTitle
      ? `in window "${event.windowTitle}"`
      : `in window ${event.windowId}`;

    let content = `<ui:click>button "${event.action}" ${windowContext}</ui:click>`;

    if (event.componentPath && event.componentPath.length > 0) {
      content += `\nComponent path: ${event.componentPath.join(' → ')}`;
    }

    if (event.formData && event.formId) {
      content += `\n\nForm data (${event.formId}):\n${JSON.stringify(event.formData, null, 2)}`;
    }

    await this.deps.getPool()?.handleTask({
      type: 'app',
      messageId: event.actionId ?? genId('component'),
      windowId: event.windowId,
      content,
      actionId: event.actionId,
    });
    // Notify other agents subscribed to this window's interactions
    this.deps.getPool()?.notifyWindowSubscribers(
      event.windowId,
      'interaction',
      `User clicked "${event.action}" ${windowContext}`,
      undefined, // no source agent — this is a user interaction
    );
  }

  private handleRenderingFeedback(
    event: ClientEventOf<typeof ClientEventType.RENDERING_FEEDBACK>,
  ): void {
    // Resolve directly via actionEmitter — the pending request is global (keyed by requestId),
    // so routing through a specific agent is unnecessary and fragile.
    actionEmitter.resolveFeedback({
      requestId: event.requestId,
      windowId: event.windowId,
      renderer: event.renderer,
      success: event.success,
      error: event.error,
      url: event.url,
      locked: event.locked,
      imageData: event.imageData,
      captureFailure: event.captureFailure,
    });
  }

  private async handleDialogFeedback(
    event: ClientEventOf<typeof ClientEventType.DIALOG_FEEDBACK>,
  ): Promise<void> {
    // Answered, so it is no longer on the screen — and must not be put back on it by
    // the next snapshot.
    this.deps.surfaces.answered(event.dialogId);
    const resolved = await actionEmitter.resolveDialogFeedback({
      dialogId: event.dialogId,
      confirmed: event.confirmed,
      rememberChoice: event.rememberChoice,
    });
    // The answer arrived for a dialog whose deadline had already passed. The request
    // it was answering is gone — that cannot be undone — but the user is owed the
    // fact, instead of a click that lands on nothing. A remembered choice, unlike the
    // answer, still counts, and resolveDialogFeedback has already saved it.
    if (!resolved) {
      this.notifyTooLate(
        event.rememberChoice && event.rememberChoice !== 'once'
          ? 'That request timed out before you answered, so it was denied. Your choice was saved and will apply next time.'
          : 'That request timed out before you answered, so it was denied.',
      );
    }
  }

  private handleToastAction(event: ClientEventOf<typeof ClientEventType.TOAST_ACTION>): void {
    this.deps.reloadCache.markFailed(event.eventId);
    console.log(
      `[ClientEventController] Reload cache entry "${event.eventId}" reported as failed by user`,
    );
  }

  private handleUserPromptResponse(
    event: ClientEventOf<typeof ClientEventType.USER_PROMPT_RESPONSE>,
  ): void {
    this.deps.surfaces.answered(event.promptId);
    const resolved = actionEmitter.resolveUserPromptFeedback({
      promptId: event.promptId,
      selectedValues: event.selectedValues,
      text: event.text,
      dismissed: event.dismissed,
    });
    // Answered after the agent stopped waiting. Silently dropping it left the user
    // believing they had replied.
    if (!resolved && !event.dismissed) {
      this.notifyTooLate('That prompt expired before you answered, so your answer was not sent.');
    }
  }

  /**
   * Windows the *user* moved, closed or opened. The registry decides what each interaction
   * means for window state (see `WindowStateRegistry.applyUserInteraction`); what is left
   * here is what is not window state — the log, and the browser sessions a closed browser
   * window owns.
   */
  private async handleUserInteraction(
    event: ClientEventOf<typeof ClientEventType.USER_INTERACTION>,
  ): Promise<void> {
    const logger = this.deps.getSessionLogger();

    for (const interaction of event.interactions) {
      logger?.logInteraction(interaction);

      const applied = await this.deps.windowState.applyUserInteraction(interaction, getAppMeta);

      this.notifyWindowWatchers(interaction);

      // Only a window the user *made* is worth replaying from the log — a move or a close
      // is already implied by the window's absence or its bounds at snapshot time.
      if (interaction.type === 'window.create') {
        for (const action of applied) logger?.logAction(action);
      }
      // Close all browser sessions (including stale ones) when any browser window is
      // closed — both the headless sandbox and the user's real-Chrome (session) door.
      if (interaction.type === 'window.close' && interaction.windowId?.startsWith('browser-')) {
        this.deps.closeBrowsers();
      }
    }

    // If all windows are now closed, also close any hidden browser sessions
    // (e.g. sessions created with visible: false that have no window)
    if (
      event.interactions.some((i) => i.type === 'window.close') &&
      this.deps.windowState.listWindows().length === 0
    ) {
      this.deps.closeBrowsers();
    }

    this.deps.getPool()?.pushUserInteractions(event.interactions);
  }

  /**
   * Wake iframe apps watching a window the user just touched, mirroring the tool-action
   * path in `LiveSession.handleEmittedAction`: change subscribers get a ping, stream
   * subscribers get a `user` frame carrying the interaction. Tool-emitted moves never come
   * through here, so a `user` frame is unambiguously the human — an app watching its own
   * window can tell "I was dragged" from "I moved myself".
   */
  private notifyWindowWatchers(interaction: UserInteraction): void {
    if (!interaction.windowId || !interaction.type.startsWith('window.')) return;

    const handle =
      this.deps.windowState.handleMap.resolve(interaction.windowId) ?? interaction.windowId;
    const uri = `yaar://windows/${handle}`;
    subscriptionRegistry.notifyChange(uri, this.deps.sessionId);
    subscriptionRegistry.publishFrame(
      uri,
      'user',
      {
        type: interaction.type,
        windowId: interaction.windowId,
        ...(interaction.bounds ? { bounds: interaction.bounds } : {}),
      },
      this.deps.sessionId,
    );
  }
}
