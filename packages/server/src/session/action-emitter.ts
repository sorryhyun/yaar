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
import { getAgentId, getMonitorId, getSessionId } from '../agents/agent-context.js';
import { clampDeadline, MAX_REQUEST_DEADLINE_MS } from '../config.js';
import {
  checkPermission,
  savePermission,
  type PermissionDecision,
} from '../storage/permissions.js';
import { PendingStore, type PendingOutcome } from './pending-store.js';
import { appendFileSync } from 'node:fs';

/** TEMPORARY debug trace — remove. */
export function dbg(line: string): void {
  try {
    appendFileSync('/tmp/yaar-dbg.log', `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* ignore */
  }
}

/**
 * Action event data.
 */
export interface ActionEvent {
  action: OSAction;
  requestId?: string;
  sessionId?: string;
  agentId?: string;
  monitorId?: string;
}

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
 * Data emitted for an app protocol request.
 */
export interface AppProtocolRequestData {
  windowId: string;
  request: AppProtocolRequest;
}

/**
 * How long an expired dialog is remembered so a click already on its way still counts.
 */
const EXPIRED_DIALOG_GRACE_MS = 5 * 60_000;

/**
 * Global action emitter instance.
 */
class ActionEmitter extends EventEmitter {
  private pendingRequests = new PendingStore<RenderingFeedback>();
  private pendingDialogs = new PendingStore<boolean, PermissionOptions | undefined>();
  private pendingUserPrompts = new PendingStore<UserPromptResult>();
  private pendingAppRequests = new PendingStore<AppProtocolResponse>();
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
  private readyWindows = new Set<string>();
  private requestCounter = 0;
  private currentMonitorId: string | undefined;
  private currentAgentId: string | undefined;

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
   * Set the current agent ID for action stamping.
   * Called before a provider turn so emitted actions carry the correct agent ID.
   * Used by providers (like Codex) that cannot pass X-Agent-Id headers on MCP requests.
   */
  setCurrentAgent(id: string): void {
    this.currentAgentId = id;
  }

  /**
   * Clear the current agent ID after a provider turn completes.
   */
  clearCurrentAgent(): void {
    this.currentAgentId = undefined;
  }

  /**
   * The fallback agent ID set by header-less providers (Codex) before a turn.
   * Used by the MCP HTTP handler to restore agent context when the inbound
   * request carries no X-Agent-Id header.
   */
  getCurrentAgentId(): string | undefined {
    return this.currentAgentId;
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
   * 2. AsyncLocalStorage context (set by Claude via X-Agent-Id header)
   * 3. Fallback currentAgentId (set by Codex provider before turn)
   */
  private resolveAgentId(explicit?: string): string | undefined {
    if (explicit) return explicit;
    const contextId = getAgentId();
    if (contextId && contextId !== 'unknown') return contextId;
    return this.currentAgentId;
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
   * Emit an OS Action to all listeners.
   */
  emitAction(action: OSAction, sessionId?: string, agentId?: string): void {
    this.emit('action', {
      action,
      sessionId,
      agentId: this.resolveAgentId(agentId),
      monitorId: this.monitorForAction(action, sessionId),
    } as ActionEvent);
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
    timeoutMs: number = 3000,
    sessionId?: string,
    /**
     * Monitor to deliver this action to, when the caller knows it better than the
     * ambient context does. Reading a window is the case: the window's own monitor is
     * the one that must render the capture, and it need not be the caller's — an
     * iframe app (devtools previewing its build) has no monitor of its own to act on.
     */
    monitorId?: string,
  ): Promise<PendingOutcome<RenderingFeedback>> {
    const requestId = this.generateRequestId();
    // Get current agent ID from context (with Codex fallback) and include in action
    const agentId = this.resolveAgentId();
    const actionWithAgent = agentId ? { ...action, agentId } : action;

    const currentSessionId = sessionId ?? getSessionId();
    const feedbackPromise = this.pendingRequests.create(requestId, {
      timeoutMs: clampDeadline(timeoutMs),
      sessionId: currentSessionId,
    });

    // Emit action with request ID, agentId from context, and monitorId
    this.emit('action', {
      action: actionWithAgent,
      requestId,
      sessionId,
      agentId,
      monitorId: monitorId ?? this.monitorForAction(action, currentSessionId),
    } as ActionEvent);

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
      this.emit('action', { action, sessionId: undefined, agentId: 'system' } as ActionEvent);
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
    timeoutMs: number = 60000, // 1 minute default timeout
  ): Promise<boolean> {
    const dialogId = `dialog-${Date.now()}-${++this.requestCounter}`;
    const agentId = getAgentId();
    const currentSessionId = getSessionId();

    const dialogPromise = this.pendingDialogs.create(dialogId, {
      timeoutMs: clampDeadline(timeoutMs),
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
      sessionId: undefined,
      agentId,
    } as ActionEvent);

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
    timeoutMs: number = 60000,
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
    const promptId = `prompt-${Date.now()}-${++this.requestCounter}`;
    const agentId = getAgentId();
    const currentSessionId = getSessionId();
    // The old default was 300s — 45s past the transport's idle timeout, so the request
    // this prompt is holding open died before the prompt could ever report expiring.
    const timeoutMs = clampDeadline(opts.timeoutMs ?? MAX_REQUEST_DEADLINE_MS);

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

    if (currentSessionId) {
      // Deliver via dedicated event -> LiveSession.broadcast() (session-scoped, no monitor filter)
      this.emit('user-prompt', {
        sessionId: currentSessionId,
        event: {
          type: ServerEventType.ACTIONS,
          actions: [action],
          agentId: agentId ?? 'system',
        },
      });
    } else {
      // Fallback: generic action path (requires active ToolActionBridge subscription)
      this.emit('action', {
        action: action as OSAction,
        sessionId: undefined,
        agentId,
      } as ActionEvent);
    }

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
   * Notify that an iframe app has registered with the App Protocol.
   * Resolves any pending waitForAppReady() calls for this window.
   */
  notifyAppReady(windowId: string): void {
    this.readyWindows.add(windowId);
    this.emit('app-ready', windowId);
  }

  /**
   * Check if an app has already signaled readiness.
   */
  isAppReady(windowId: string): boolean {
    return this.readyWindows.has(windowId);
  }

  /**
   * Wait for an iframe app to register with the App Protocol.
   * Resolves true if the app is already ready or becomes ready within the timeout.
   */
  waitForAppReady(windowId: string, timeoutMs: number = 5000): Promise<boolean> {
    if (this.readyWindows.has(windowId)) return Promise.resolve(true);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.off('app-ready', handler);
        resolve(false);
      }, timeoutMs);

      const handler = (readyWindowId: string) => {
        if (readyWindowId === windowId) {
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
    timeoutMs: number = 5000,
  ): Promise<PendingOutcome<AppProtocolResponse>> {
    const requestId = this.generateRequestId();
    const currentSessionId = getSessionId();

    const responsePromise = this.pendingAppRequests.create(requestId, {
      timeoutMs: clampDeadline(timeoutMs),
      sessionId: currentSessionId,
    });

    dbg(
      `emitAppProtocolRequest ${requestId} window=${windowId} timeoutMs=${timeoutMs} session=${currentSessionId}`,
    );

    // Pass the deadline to the frontend too — it times the postMessage leg itself, and a
    // shorter fixed timer there would override whatever the caller asked for.
    this.emit('app-protocol', { requestId, windowId, request, timeoutMs });

    return responsePromise;
  }

  /**
   * Resolve a pending app protocol request with a response from the iframe.
   * Called by the session when it receives an APP_PROTOCOL_RESPONSE from the frontend.
   */
  resolveAppProtocolResponse(requestId: string, response: AppProtocolResponse): boolean {
    const resolved = this.pendingAppRequests.resolve(requestId, response).resolved;
    dbg(`resolveAppProtocolResponse ${requestId} → resolved=${resolved}`);
    return resolved;
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
    timeoutMs: number = 60000,
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
      timeoutMs: clampDeadline(timeoutMs),
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
   */
  clearPendingForSession(sessionId: string): void {
    this.pendingRequests.clearForSession(sessionId);
    this.pendingDialogs.clearForSession(sessionId);
    this.pendingUserPrompts.clearForSession(sessionId);
    this.pendingAppRequests.clearForSession(sessionId);
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
