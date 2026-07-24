/**
 * Action emitter - allows tools to emit OS Actions directly.
 *
 * This bridges the gap between MCP tool execution and the WebSocket
 * connection to the frontend. Tools emit actions here, and the agent
 * session subscribes to receive them.
 */

import { EventEmitter } from 'events';
import {
  ServerEventType,
  type OSAction,
  type DialogConfirmAction,
  type DialogCloseAction,
  type PermissionOptions,
  type AppProtocolRequest,
  type AppProtocolResponse,
  type UserPromptShowAction,
  type UserPromptDismissAction,
  type UserPromptOption,
  type UserPromptInputField,
} from '@yaar/shared';
import type { ActionEmitterChannels, ActionEvent, AppReadyEvent } from './emitter-channels.js';
import { getAgentId, getMonitorId, getSessionId } from '../agents/agent-context.js';
import { clampDeadline, deadlines } from '../config.js';
import {
  checkPermission,
  savePermission,
  type PermissionDecision,
} from '../storage/permissions.js';
import { PendingStore, type PendingOutcome } from './pending-store.js';

/**
 * The channel payloads live in `emitter-channels.ts` alongside the map that says which
 * channel carries which. Re-exported here because this module is where consumers have
 * always imported `ActionEvent` from.
 */
export type {
  ActionEvent,
  AppProtocolRequestData,
  AppReadyEvent,
  SessionScopedEvent,
} from './emitter-channels.js';

/**
 * Rendering feedback from frontend.
 */
export interface RenderingFeedback {
  requestId: string;
  windowId: string;
  renderer: string;
  success: boolean;
  error?: string;
  url?: string;
  locked?: boolean;
  imageData?: string;
  /** Why a capture produced no image. See RenderingFeedbackEvent.captureFailure. */
  captureFailure?: string;
}

/**
 * Dialog feedback from frontend.
 */
export interface DialogFeedback {
  dialogId: string;
  confirmed: boolean;
  rememberChoice?: 'once' | 'always' | 'deny_always';
}

/**
 * User prompt response from frontend.
 */
export interface UserPromptFeedback {
  promptId: string;
  selectedValues?: string[];
  text?: string;
  dismissed?: boolean;
}

/**
 * Resolved user prompt result returned to tool handlers.
 *
 * `dismissed` with `timedOut` is not the same event as `dismissed` alone: one is the user
 * saying no, the other is the user never seeing the question — or seeing it and thinking.
 * A tool that reports the second as the first tells the agent the user declined something
 * they were never asked.
 */
export interface UserPromptResult {
  selectedValues?: string[];
  text?: string;
  dismissed: boolean;
  /** The deadline passed with no answer, and the prompt was withdrawn from the screen. */
  timedOut?: boolean;
}

/**
 * How long an expired dialog is remembered so a click already on its way still counts.
 */
const EXPIRED_DIALOG_GRACE_MS = 5 * 60_000;

/**
 * How long an expired app protocol request is remembered, so that a reply arriving after
 * its deadline can be reported as *late* rather than merely unknown. See
 * `resolveAppProtocolResponse`.
 */
const EXPIRED_APP_REQUEST_GRACE_MS = 5 * 60_000;

/** What an in-flight app protocol request was, kept so a late reply can be named. */
interface AppRequestMeta {
  windowId: string;
  kind: AppProtocolRequest['kind'];
  startedAt: number;
  timeoutMs: number;
}

/**
 * Global action emitter instance.
 *
 * Typed by {@link ActionEmitterChannels}: the channel names and payloads it accepts are
 * the ones listed there, checked at compile time. See that module for why.
 */
class ActionEmitter extends EventEmitter<ActionEmitterChannels> {
  private pendingRequests = new PendingStore<RenderingFeedback>();
  private pendingDialogs = new PendingStore<boolean, PermissionOptions | undefined>();
  private pendingUserPrompts = new PendingStore<UserPromptResult>();
  private pendingAppRequests = new PendingStore<AppProtocolResponse, AppRequestMeta>();
  /**
   * App protocol requests whose deadline passed, kept just long enough to recognize a reply
   * that arrives afterwards. A late reply used to be dropped in silence — which is exactly
   * why a frontend relay timer firing six seconds past its own deadline stayed invisible
   * for so long: the agent was told "the app did not respond", and nothing anywhere said
   * that the app *had* responded, merely too late to matter.
   */
  private expiredAppRequests = new Map<string, AppRequestMeta>();
  /**
   * Dialogs whose deadline passed, kept so a click that lands just after expiry is not
   * thrown away. The window is small (the dialog is off the screen by then) but real —
   * and the thing being thrown away was the user's *"don't ask me again"*, which is a
   * durable decision, not an answer to one request. See resolveDialogFeedback.
   */
  private expiredDialogs = new Map<
    string,
    { permissionOptions?: PermissionOptions; expiredAt: number }
  >();
  /**
   * Which iframes have registered with the App Protocol — per session, per window key.
   *
   * The window key ("0/ai-chat") names a window on a monitor, and *every* session has a
   * monitor 0. Keyed by that alone (as this was) the set is a claim about the process, not
   * about anyone's browser: the first session to open an app made that key ready forever,
   * so the next session's `waitForAppReady` returned true for an iframe that had never
   * spoken, `requireAppReady` stopped being a wait, and the first command went out to an
   * iframe not yet listening — reaching the agent as "App did not respond".
   *
   * So the session is in the key, and the whole entry is dropped when the session goes
   * (`clearPendingForSession`) or the window closes (`forgetAppReady`). Nothing ever left
   * the old set, either: a desktop open for a day accumulated one entry per window it had
   * ever shown.
   */
  private readyWindows = new Map<string, Set<string>>();
  private requestCounter = 0;
  private currentMonitorId: string | undefined;

  /**
   * Set the current monitor ID for action stamping.
   * Called before a provider turn so emitted actions carry the correct monitor.
   */
  setCurrentMonitor(id: string): void {
    this.currentMonitorId = id;
  }

  /**
   * Clear the current monitor ID after a provider turn completes.
   */
  clearCurrentMonitor(): void {
    this.currentMonitorId = undefined;
  }

  /**
   * Generate a unique request ID.
   */
  private generateRequestId(): string {
    return `req-${Date.now()}-${++this.requestCounter}`;
  }

  /**
   * Resolve the effective agent ID from (in priority order):
   * 1. Explicit parameter
   * 2. AsyncLocalStorage context — set from the server-minted agent token at the
   *    MCP boundary (Claude via `X-Agent-Token`, Codex via the per-thread
   *    `mcp_servers` header). Every turn stamps `agentId` unconditionally, so there
   *    is no header-less provider left to fall back for.
   */
  private resolveAgentId(explicit?: string): string | undefined {
    if (explicit) return explicit;
    const contextId = getAgentId();
    if (contextId && contextId !== 'unknown') return contextId;
    return undefined;
  }

  /**
   * The monitor an emitted action belongs to.
   *
   * Prefers the AsyncLocalStorage context, which is exact per emitter — it names
   * the monitor of whoever is running right now. `currentMonitorId` is a single
   * mutable field set around provider turns, so it is only a fallback (Codex,
   * which cannot stamp identity onto MCP requests). Reading the field first would
   * stamp actions emitted outside a turn — an app's iframe calling a verb, say —
   * with whichever monitor the last agent turn happened to leave behind, which is
   * how a window opened from monitor 1's dock lands on monitor 0.
   */
  private resolveMonitorId(): string | undefined {
    return getMonitorId() ?? this.currentMonitorId;
  }

  /**
   * The monitor a *window* action belongs to — never undefined, never guessed.
   *
   * Windows are keyed by `{monitorId}/{rawId}` in both registries, so an unstamped
   * window action is not a window on no monitor; it is a window whose monitor the
   * server and the frontend then each guess at, separately. The server fell back to
   * a bare `"ai-chat"` key while the frontend used its active monitor and produced
   * `"1/ai-chat"` — one app, two keys, and a second window on screen.
   *
   * The old fallback chain ended at the session's "active monitor" and then at
   * monitor 0. Both were guesses, and the second guess was wrong precisely when it
   * mattered. Every window action is emitted from inside something that knows its
   * monitor — an agent turn, or an iframe verb call whose token records the monitor
   * its window is on. One that isn't cannot be placed, and a window placed by guess
   * is worse than a window that fails to open: it opens somewhere the user isn't
   * looking, on an agent that wasn't asked.
   */
  resolveWindowMonitor(_sessionId?: string): string {
    const monitorId = this.resolveMonitorId();
    if (!monitorId) {
      throw new Error(
        'Cannot place a window action: no monitor in context. Window actions must be ' +
          'emitted inside an agent turn or an iframe verb call, both of which carry one.',
      );
    }
    return monitorId;
  }

  /** Monitor to stamp on an emitted action, forced for window actions. */
  private monitorForAction(action: OSAction, sessionId?: string): string | undefined {
    return action.type.startsWith('window.')
      ? this.resolveWindowMonitor(sessionId)
      : this.resolveMonitorId();
  }

  /**
   * The session an emitted action is addressed to — explicit argument, else the agent
   * context, else nothing.
   *
   * Returning `undefined` is a delivery failure, not a fallback, and every caller here
   * treats it as one. There was a third option once — `SessionHub.getDefault()` — and it
   * is exactly what this method exists to refuse: "the session that happens to be first
   * in the map" is a correct answer only while there is one session, and the whole point
   * of addressing is the case where there is more than one.
   */
  private resolveSessionId(explicit?: string): string | undefined {
    return explicit ?? getSessionId();
  }

  /**
   * Say, once and loudly, that an action could not be addressed.
   *
   * Dropping is deliberate: broadcasting to an arbitrary session puts a window on a
   * stranger's desktop, which is worse than not opening it. Dropping *silently* would be
   * worse than both, hence the error — the message names the action type because that is
   * what identifies the call site that needs a session threaded through it.
   */
  private reportUnaddressed(what: string): void {
    console.error(
      `[ActionEmitter] Dropped ${what}: no session in context and none passed. ` +
        'Frontend-directed emits must run inside an agent turn or an iframe verb call, ' +
        'or name their session explicitly.',
    );
  }

  /**
   * Emit an OS Action to the session it belongs to.
   *
   * `sessionId` stays optional in the signature because almost every caller runs inside an
   * agent turn or iframe verb call and the context already holds the answer. What is not
   * optional is that an answer exists.
   */
  emitAction(action: OSAction, sessionId?: string, agentId?: string): void {
    const sid = this.resolveSessionId(sessionId);
    if (!sid) {
      this.reportUnaddressed(`action ${action.type}`);
      return;
    }
    this.emit('action', {
      action,
      sessionId: sid,
      agentId: this.resolveAgentId(agentId),
      monitorId: this.monitorForAction(action, sid),
    });
  }

  /**
   * Emit an OS Action and wait for feedback from the frontend.
   *
   * The outcome distinguishes "the frontend answered" from "the frontend said nothing in
   * time", because those mean different things to different callers and only the caller
   * knows which: a lock veto that never arrives means *proceed*, an iframe that never
   * reports means *do not tell the agent it rendered*. Both used to arrive here as `null`.
   */
  async emitActionWithFeedback(
    action: OSAction,
    timeoutMs?: number,
    sessionId?: string,
    /**
     * Monitor to deliver this action to, when the caller knows it better than the
     * ambient context does. Reading a window is the case: the window's own monitor is
     * the one that must render the capture, and it need not be the caller's — an
     * iframe app (devtools previewing its build) has no monitor of its own to act on.
     */
    monitorId?: string,
  ): Promise<PendingOutcome<RenderingFeedback>> {
    const currentSessionId = this.resolveSessionId(sessionId);
    if (!currentSessionId) {
      // Settle now rather than creating a pending entry nothing can answer. A caller
      // that waits out a full deadline for an action that was never delivered reads the
      // silence as "the frontend declined", which is a different fact entirely.
      this.reportUnaddressed(`action ${action.type} (awaiting feedback)`);
      return { ok: false, reason: 'cancelled' };
    }

    const requestId = this.generateRequestId();
    // Get current agent ID from context (with Codex fallback) and include in action
    const agentId = this.resolveAgentId();
    const actionWithAgent = agentId ? { ...action, agentId } : action;

    const feedbackPromise = this.pendingRequests.create(requestId, {
      timeoutMs: clampDeadline(timeoutMs ?? deadlines.renderFeedbackMs),
      sessionId: currentSessionId,
    });

    // Emit action with request ID, agentId from context, and monitorId
    this.emit('action', {
      action: actionWithAgent,
      requestId,
      sessionId: currentSessionId,
      agentId,
      monitorId: monitorId ?? this.monitorForAction(action, currentSessionId),
    });

    return feedbackPromise;
  }

  /**
   * Resolve a pending request with feedback.
   * Called by the session when it receives rendering feedback from frontend.
   */
  resolveFeedback(feedback: RenderingFeedback): boolean {
    return this.pendingRequests.resolve(feedback.requestId, feedback).resolved;
  }

  /**
   * Deliver an action to a whole session, from outside any agent turn.
   *
   * An expiry fires on a timer, so there is no AsyncLocalStorage context to stamp a
   * monitor from — and a dialog belongs to the session anyway, not to one monitor. The
   * dedicated channel reaches `LiveSession.broadcast()` (see the listeners in
   * live-session.ts); emitting on `'action'` instead would only reach a session with a
   * live ToolActionBridge subscription, which by expiry time there may not be.
   */
  private emitSessionAction(sessionId: string | undefined, action: OSAction): void {
    if (!sessionId) {
      // There is nothing to fall back to. This used to re-emit on `'action'`, which
      // reached whichever sessions happened to be listening — and a dialog being taken
      // off *someone's* screen is not a partial success.
      this.reportUnaddressed(`session action ${action.type}`);
      return;
    }
    this.emit('session-action', {
      sessionId,
      event: { type: ServerEventType.ACTIONS, actions: [action], agentId: 'system' },
    });
  }

  /** Drop dialogs that expired long enough ago that no click can still be in flight. */
  private pruneExpiredDialogs(): void {
    const cutoff = Date.now() - EXPIRED_DIALOG_GRACE_MS;
    for (const [id, entry] of this.expiredDialogs) {
      if (entry.expiredAt < cutoff) this.expiredDialogs.delete(id);
    }
  }

  /**
   * A dialog's deadline passed: take it off the screen and remember that it was asked.
   *
   * The tool that asked has already been told "denied" by then. Leaving the dialog up
   * leaves the user a live-looking question wired to nothing.
   */
  private expireDialog(
    dialogId: string,
    sessionId: string | undefined,
    permissionOptions: PermissionOptions | undefined,
  ): void {
    this.pruneExpiredDialogs();
    this.expiredDialogs.set(dialogId, { permissionOptions, expiredAt: Date.now() });
    const close: DialogCloseAction = { type: 'dialog.close', id: dialogId, reason: 'timeout' };
    this.emitSessionAction(sessionId, close as OSAction);
  }

  /**
   * Show a confirmation dialog and wait for user response.
   *
   * An unanswered dialog is a denial — but it is now an *explicit* one: the deadline
   * passes, the dialog leaves the screen, and this returns false because nobody said yes,
   * not because false was lying around as a default.
   */
  async showConfirmDialog(
    title: string,
    message: string,
    confirmText: string = 'Yes',
    cancelText: string = 'No',
    timeoutMs?: number,
  ): Promise<boolean> {
    const agentId = getAgentId();
    const currentSessionId = getSessionId();
    if (!currentSessionId) {
      // A dialog nobody can be shown cannot be answered, and an unanswered dialog is a
      // denial — so this is the same `false` the deadline would have produced, minus the
      // wait, plus a line saying why.
      this.reportUnaddressed(`confirm dialog "${title}"`);
      return false;
    }
    const dialogId = `dialog-${Date.now()}-${++this.requestCounter}`;

    const dialogPromise = this.pendingDialogs.create(dialogId, {
      timeoutMs: clampDeadline(timeoutMs ?? deadlines.dialogMs),
      sessionId: currentSessionId,
      meta: undefined,
      onExpire: (id) => this.expireDialog(id, currentSessionId, undefined),
    });

    const action: DialogConfirmAction = {
      type: 'dialog.confirm',
      id: dialogId,
      title,
      message,
      confirmText,
      cancelText,
    };

    this.emit('action', {
      action: action as OSAction,
      sessionId: currentSessionId,
      agentId,
    });

    const outcome = await dialogPromise;
    return outcome.ok ? outcome.value : false;
  }

  /**
   * Show a permission dialog with "Remember my choice" option.
   *
   * Resolves the session ID from the current agent context and delegates
   * to showPermissionDialogToSession() for delivery via LiveSession.broadcast().
   */
  async showPermissionDialog(
    title: string,
    message: string,
    toolName: string,
    context?: string,
    confirmText: string = 'Allow',
    cancelText: string = 'Deny',
    timeoutMs?: number,
  ): Promise<boolean> {
    const sessionId = getSessionId();
    if (!sessionId) {
      console.warn('[ActionEmitter] showPermissionDialog called without agent context');
      return false;
    }
    return this.showPermissionDialogToSession(
      sessionId,
      title,
      message,
      toolName,
      context,
      confirmText,
      cancelText,
      timeoutMs,
    );
  }

  /**
   * Resolve a pending dialog with feedback.
   *
   * Returns false when the answer arrived for a dialog that had already expired — the
   * request it was answering is long gone and cannot be un-denied. But *"remember my
   * choice"* is not an answer to that request: it is a standing instruction about every
   * future one, and it is saved either way. Dropping it (as this did, along with the
   * whole late click) meant a user who ticked "always allow" a moment too late got asked
   * again, forever, with no sign that their choice had gone anywhere.
   */
  async resolveDialogFeedback(feedback: DialogFeedback): Promise<boolean> {
    const { resolved, meta } = this.pendingDialogs.resolve(feedback.dialogId, feedback.confirmed);

    const expired = resolved ? undefined : this.expiredDialogs.get(feedback.dialogId);
    if (expired) this.expiredDialogs.delete(feedback.dialogId);
    const permissionOptions = resolved ? meta : expired?.permissionOptions;

    // Save permission if user chose to remember (business logic stays here, not in PendingStore)
    if (permissionOptions && feedback.rememberChoice) {
      const { toolName, context } = permissionOptions;
      let decision: PermissionDecision = 'ask';

      if (feedback.rememberChoice === 'always') {
        decision = 'allow';
      } else if (feedback.rememberChoice === 'deny_always') {
        decision = 'deny';
      }

      if (decision !== 'ask') {
        await savePermission(toolName, decision, context);
      }
    }

    return resolved;
  }

  /**
   * Show a user prompt (ask or request) and wait for response.
   *
   * - Provide `options` for a selection prompt (ask).
   * - Provide `inputField` for a text input prompt (request).
   * - Provide both for a selection with an "Other" freeform option.
   */
  async showUserPrompt(opts: {
    title: string;
    message: string;
    options?: UserPromptOption[];
    multiSelect?: boolean;
    inputField?: UserPromptInputField;
    allowDismiss?: boolean;
    timeoutMs?: number;
  }): Promise<UserPromptResult> {
    const agentId = getAgentId();
    const currentSessionId = getSessionId();
    if (!currentSessionId) {
      // Nobody can be asked, so report it as nobody having answered — `dismissed` without
      // `timedOut`, which is the shape a caller already knows how to read.
      this.reportUnaddressed(`user prompt "${opts.title}"`);
      return { dismissed: true };
    }
    const promptId = `prompt-${Date.now()}-${++this.requestCounter}`;
    // The old default was 300s — 45s past the transport's idle timeout, so the request
    // this prompt is holding open died before the prompt could ever report expiring.
    const timeoutMs = clampDeadline(opts.timeoutMs ?? deadlines.userPromptMs);

    const promptPromise = this.pendingUserPrompts.create(promptId, {
      timeoutMs,
      sessionId: currentSessionId,
      onExpire: (id) =>
        this.emitSessionAction(currentSessionId, {
          type: 'user.prompt.dismiss',
          id,
        } as UserPromptDismissAction as OSAction),
    });

    const action: UserPromptShowAction = {
      type: 'user.prompt.show',
      id: promptId,
      title: opts.title,
      message: opts.message,
      options: opts.options,
      multiSelect: opts.multiSelect,
      inputField: opts.inputField,
      allowDismiss: opts.allowDismiss ?? true,
    };

    // Deliver via dedicated event -> LiveSession.broadcast() (session-scoped, no monitor filter)
    this.emit('user-prompt', {
      sessionId: currentSessionId,
      event: {
        type: ServerEventType.ACTIONS,
        actions: [action],
        agentId: agentId ?? 'system',
      },
    });

    const outcome = await promptPromise;
    if (outcome.ok) return outcome.value;
    // Nobody answered. Say that, rather than reporting it as the user declining.
    return { dismissed: true, timedOut: outcome.reason === 'timeout' };
  }

  /**
   * Resolve a pending user prompt with feedback from the frontend.
   */
  resolveUserPromptFeedback(feedback: UserPromptFeedback): boolean {
    return this.pendingUserPrompts.resolve(feedback.promptId, {
      selectedValues: feedback.selectedValues,
      text: feedback.text,
      dismissed: feedback.dismissed ?? false,
    }).resolved;
  }

  /**
   * Notify that an iframe app in `sessionId` has registered with the App Protocol.
   * Resolves any pending waitForAppReady() calls for that session's window.
   */
  notifyAppReady(sessionId: string, windowId: string): void {
    let windows = this.readyWindows.get(sessionId);
    if (!windows) {
      windows = new Set();
      this.readyWindows.set(sessionId, windows);
    }
    windows.add(windowId);
    this.emit('app-ready', { sessionId, windowId } as AppReadyEvent);
  }

  /**
   * Check if an app has already signaled readiness *in this session*.
   */
  isAppReady(sessionId: string, windowId: string): boolean {
    return this.readyWindows.get(sessionId)?.has(windowId) ?? false;
  }

  /**
   * Forget one window's registration — it closed.
   *
   * A window key is reused: close "ai-chat" and open it again and the key is the same, but
   * the iframe behind it is a new document that has not registered. A registration that
   * outlived its window would tell the next one's first command that the app is already
   * listening. This is the same defect as the cross-session one, at a smaller radius.
   */
  forgetAppReady(sessionId: string, windowId: string): void {
    const windows = this.readyWindows.get(sessionId);
    if (!windows) return;
    windows.delete(windowId);
    if (windows.size === 0) this.readyWindows.delete(sessionId);
  }

  /**
   * Wait for an iframe app to register with the App Protocol, in the caller's session.
   * Resolves true if that session's app is already ready or becomes ready within the timeout.
   *
   * `sessionId` is required and not defaulted: a wait that cannot name whose iframe it is
   * waiting for is the bug. An undefined session matches no registration (they all carry
   * one), so it waits out its deadline rather than borrowing another session's answer —
   * but it is also unreachable in practice, since the window registry the caller checked
   * before waiting was itself resolved from a session.
   */
  waitForAppReady(
    sessionId: string | undefined,
    windowId: string,
    timeoutMs?: number,
  ): Promise<boolean> {
    if (sessionId !== undefined && this.isAppReady(sessionId, windowId)) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.off('app-ready', handler);
        resolve(false);
      }, timeoutMs ?? deadlines.appReadyMs);

      const handler = (ready: AppReadyEvent) => {
        if (ready.sessionId === sessionId && ready.windowId === windowId) {
          clearTimeout(timeout);
          this.off('app-ready', handler);
          resolve(true);
        }
      };

      this.on('app-ready', handler);
    });
  }

  /**
   * Send an app protocol request to an iframe app and wait for its response.
   * The outcome is `ok: false` if the app does not answer within the deadline.
   */
  async emitAppProtocolRequest(
    windowId: string,
    request: AppProtocolRequest,
    timeoutMs?: number,
    sessionId?: string,
  ): Promise<PendingOutcome<AppProtocolResponse>> {
    const currentSessionId = this.resolveSessionId(sessionId);
    if (!currentSessionId) {
      // The pending entry was always created against the caller's session; only the
      // *request* went out unaddressed. Without a session there is no iframe to ask, so
      // this is `cancelled` — the caller's "the app is unreachable" branch — rather than
      // a deadline the frontend was never given a chance to meet.
      this.reportUnaddressed(`app protocol ${request.kind} for ${windowId}`);
      return { ok: false, reason: 'cancelled' };
    }

    const requestId = this.generateRequestId();
    const deadlineMs = clampDeadline(timeoutMs ?? deadlines.appQueryMs);
    const meta: AppRequestMeta = {
      windowId,
      kind: request.kind,
      startedAt: Date.now(),
      timeoutMs: deadlineMs,
    };

    const responsePromise = this.pendingAppRequests.create(requestId, {
      timeoutMs: deadlineMs,
      sessionId: currentSessionId,
      meta,
      onExpire: (id, expiredMeta) => {
        this.pruneExpiredAppRequests();
        this.expiredAppRequests.set(id, expiredMeta);
      },
    });

    // Pass the deadline to the frontend too — it relays the postMessage leg and needs to
    // know how long we are prepared to wait. It no longer times the leg itself: this
    // deadline is the only one.
    this.emit('app-protocol', {
      sessionId: currentSessionId,
      requestId,
      windowId,
      request,
      timeoutMs: deadlineMs,
    });

    return responsePromise;
  }

  /** Forget app requests that expired too long ago for any reply to still be in flight. */
  private pruneExpiredAppRequests(): void {
    const cutoff = Date.now() - EXPIRED_APP_REQUEST_GRACE_MS;
    for (const [id, meta] of this.expiredAppRequests) {
      if (meta.startedAt + meta.timeoutMs < cutoff) this.expiredAppRequests.delete(id);
    }
  }

  /**
   * Resolve a pending app protocol request with a response from the iframe.
   * Called by the session when it receives an APP_PROTOCOL_RESPONSE from the frontend.
   *
   * A reply for an id we no longer hold cannot be un-timed-out — the agent has already been
   * told the app said nothing. But it is *said out loud* now, with the latency that made it
   * useless, because a silent drop here is what made a whole class of relay bugs present as
   * "the app is broken" three layers away.
   */
  resolveAppProtocolResponse(requestId: string, response: AppProtocolResponse): boolean {
    const { resolved } = this.pendingAppRequests.resolve(requestId, response);
    if (resolved) return true;

    const expired = this.expiredAppRequests.get(requestId);
    if (expired) {
      this.expiredAppRequests.delete(requestId);
      const latency = Date.now() - expired.startedAt;
      console.warn(
        `[AppProtocol] Late reply for ${requestId} (${expired.kind} on ${expired.windowId}): ` +
          `arrived after ${latency}ms, ${latency - expired.timeoutMs}ms past its ${expired.timeoutMs}ms ` +
          `deadline. The agent was already told the app did not respond.`,
      );
    } else {
      console.warn(
        `[AppProtocol] Reply for unknown request ${requestId} (${response.kind}) — no pending ` +
          `entry, and none expired recently. Duplicate reply, or a request from a dead session.`,
      );
    }
    return false;
  }

  /**
   * Show a permission dialog targeted at a specific session via BroadcastCenter.
   *
   * Unlike showPermissionDialog() which broadcasts through the EventEmitter
   * (reaching all agent sessions), this sends the APPROVAL_REQUEST directly
   * to a session's WebSocket connections. Used by the /api/fetch proxy route
   * where there's no agent context.
   */
  async showPermissionDialogToSession(
    sessionId: string,
    title: string,
    message: string,
    toolName: string,
    context?: string,
    confirmText: string = 'Allow',
    cancelText: string = 'Deny',
    timeoutMs?: number,
  ): Promise<boolean> {
    // Check for saved permission first
    const savedDecision = await checkPermission(toolName, context);
    if (savedDecision === 'allow') return true;
    if (savedDecision === 'deny') return false;

    const dialogId = `dialog-${Date.now()}-${++this.requestCounter}`;

    const permissionOptions: PermissionOptions = {
      showRememberChoice: true,
      toolName,
      context,
    };

    const dialogPromise = this.pendingDialogs.create(dialogId, {
      timeoutMs: clampDeadline(timeoutMs ?? deadlines.dialogMs),
      sessionId,
      meta: permissionOptions,
      onExpire: (id, meta) => this.expireDialog(id, sessionId, meta),
    });

    // Emit through the event system so LiveSession.broadcast() handles delivery
    // (same pattern as 'app-protocol' events — ensures seq stamping and proper routing)
    this.emit('approval-request', {
      sessionId,
      event: {
        type: ServerEventType.APPROVAL_REQUEST,
        dialogId,
        title,
        message,
        confirmText,
        cancelText,
        permissionOptions,
        agentId: getAgentId() ?? 'system',
      },
    });

    const outcome = await dialogPromise;
    return outcome.ok ? outcome.value : false;
  }

  /**
   * Force-clear all pending requests, dialogs, and app protocol requests belonging to a
   * session. Each settles as `cancelled` so an awaiting tool unblocks immediately instead
   * of waiting out its own deadline against a session that no longer exists.
   *
   * The session's app-protocol registrations go with them: they were claims about iframes
   * in *this* browser, and the browser is gone. Left behind, they would answer the next
   * session's `waitForAppReady` on behalf of a document that no longer exists.
   */
  clearPendingForSession(sessionId: string): void {
    this.pendingRequests.clearForSession(sessionId);
    this.pendingDialogs.clearForSession(sessionId);
    this.pendingUserPrompts.clearForSession(sessionId);
    this.pendingAppRequests.clearForSession(sessionId);
    this.readyWindows.delete(sessionId);
  }

  /**
   * Subscribe to action events.
   */
  onAction(callback: (event: ActionEvent) => void): () => void {
    this.on('action', callback);
    return () => this.off('action', callback);
  }
}

/**
 * Singleton instance.
 */
export const actionEmitter = new ActionEmitter();
