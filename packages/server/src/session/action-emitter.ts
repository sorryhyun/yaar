/**
 * Action emitter - allows tools to emit OS Actions directly.
 *
 * This bridges the gap between MCP tool execution and the WebSocket
 * connection to the frontend. Tools emit actions here, and the agent
 * session subscribes to receive them.
 *
 * What is left in this file is the emitter: addressing an action to a session and a
 * monitor, and the six questions the server asks a desktop. The three things that were
 * only ever *stored* here live beside their own rules now —
 * {@link DesktopRequest} (the ask-and-wait prelude every question shares),
 * {@link AppReadyRegistry} (which iframes are listening), and
 * {@link InterruptGate} (whose stopped turn is still emitting debris).
 * The singleton's public surface is unchanged; it is the facade over all three.
 */

import { EventEmitter } from 'events';
import {
  ServerEventType,
  type OSAction,
  type DialogConfirmAction,
  type DialogCloseAction,
  type PermissionOptions,
  type CapabilityLine,
  type AppProtocolRequest,
  type AppProtocolResponse,
  type UserPromptShowAction,
  type UserPromptDismissAction,
  type UserPromptOption,
  type UserPromptInputField,
  type UserClipboardAction,
  type ClipboardResponseEvent,
} from '@yaar/shared';
import type { ActionEmitterChannels, ActionEvent, AppReadyEvent } from './emitter-channels.js';
import { getAgentId, getMonitorId, getSessionId } from '../agents/agent-context.js';
import { clampDeadline, deadlines } from '../config.js';
import {
  checkPermission,
  savePermission,
  type PermissionDecision,
} from '../storage/permissions.js';
import type { PendingOutcome } from './pending-store.js';
import { DesktopRequest, LATE_ANSWER_GRACE_MS, reportUnaddressed } from './desktop-request.js';
import { AppReadyRegistry } from './app-ready-registry.js';
import { InterruptGate } from './interrupt-gate.js';
import { createLogger } from '../observability/log.js';

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

const log = createLogger('ActionEmitter');
/** App-protocol reply bookkeeping is its own subject; it keeps the name it always logged under. */
const appProtocolLog = createLogger('AppProtocol');

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
  /** What a successful capture left out. See RenderingFeedbackEvent.captureDegraded. */
  captureDegraded?: string[];
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
 * The desktop's answer to a clipboard read or write, minus the frame's own `type`.
 *
 * Structurally the `CLIPBOARD_RESPONSE` payload, so the controller forwards it without
 * re-describing it — but named here because this is the shape a *tool* reads.
 */
export type ClipboardFeedback = Omit<ClipboardResponseEvent, 'type'>;

/**
 * One permission question, as its asker states it.
 *
 * An options object rather than the eight positional parameters this used to take: with
 * `context`, `confirmText`, `cancelText` and `timeoutMs` all optional and all strings-or-
 * numbers, a caller that wanted only `capabilities` had to count commas and write
 * `undefined, // default deadline` to get there. Two of the thirteen call sites did.
 */
export interface PermissionDialogRequest {
  title: string;
  message: string;
  /** What is being asked for, as `checkPermission`/`savePermission` key it. */
  toolName: string;
  /** Narrows the saved decision — the domain, the app id, the path. */
  context?: string;
  confirmText?: string;
  cancelText?: string;
  timeoutMs?: number;
  /** Structured rows the dialog can weight individually. See `capabilityLines()`. */
  capabilities?: CapabilityLine[];
}

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
  private renderRequests = new DesktopRequest<RenderingFeedback>({ prefix: 'req' });

  /**
   * Dialogs keep a grace window because the thing arriving late is not only an answer:
   * it may carry *"don't ask me again"*, which is a standing instruction about every
   * future request rather than an answer to this one. Dropping the late click dropped
   * that too, so a user who ticked "always allow" a moment past the deadline got asked
   * again, forever, with no sign their choice had gone anywhere.
   */
  private dialogs = new DesktopRequest<boolean, PermissionOptions | undefined>({
    prefix: 'dialog',
    graceMs: LATE_ANSWER_GRACE_MS,
  });

  private userPrompts = new DesktopRequest<UserPromptResult>({ prefix: 'prompt' });

  private clipboardRequests = new DesktopRequest<ClipboardFeedback>({ prefix: 'clip' });

  /**
   * App requests keep a grace window so a late reply can be reported as *late* rather
   * than merely unknown. A silent drop here is exactly why a frontend relay timer firing
   * six seconds past its own deadline stayed invisible for so long: the agent was told
   * "the app did not respond", and nothing anywhere said that the app *had* responded,
   * merely too late to matter.
   */
  private appRequests = new DesktopRequest<AppProtocolResponse, AppRequestMeta>({
    prefix: 'req',
    graceMs: LATE_ANSWER_GRACE_MS,
  });

  /** Which iframes are listening right now, per session. See {@link AppReadyRegistry}. */
  private appReady = new AppReadyRegistry();

  /** Whose stopped turn is still emitting. See {@link InterruptGate}. */
  private interrupts = new InterruptGate();

  private currentMonitorId: string | undefined;

  /**
   * Agent ids already reported taking the `currentMonitorId` fallback — see
   * {@link resolveMonitorId}. Goes away with the field it measures.
   */
  private fallbackReported = new Set<string>();

  /** See {@link InterruptGate.mark}. */
  markInterrupted(agentId: string): void {
    this.interrupts.mark(agentId);
  }

  /** See {@link InterruptGate.clear}. */
  clearInterrupted(agentId: string): void {
    this.interrupts.clear(agentId);
  }

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
   *
   * **The fallback is on notice, and this is the measurement.** It is the only
   * cross-session mutable global left in this layer — one field, set around every
   * provider turn on both providers, last writer wins across concurrent turns — and it
   * undercuts `resolveWindowMonitor`'s own "never place a window by guess" rule from
   * underneath. Its stated justification (Codex cannot stamp identity onto MCP
   * requests) has been false since agent tokens: `mcp/server.ts` resolves the monitor
   * from `hub.findMonitorForAgent(agentId)` for *both* providers.
   *
   * What is left is the case that resolver cannot answer — an agent in no monitor
   * collection. Ephemerals are the known one (they have no monitor by design), and the
   * session agent between turns is the other. So the line below names the agent rather
   * than merely counting: what the field is really covering decides whether deleting it
   * means removing four provider call sites or giving ephemerals a monitor first. Once
   * per agent id, because the answer is which *tier* takes it, not how often.
   */
  private resolveMonitorId(): string | undefined {
    const contextMonitorId = getMonitorId();
    if (contextMonitorId) return contextMonitorId;
    if (this.currentMonitorId) this.reportMonitorFallback();
    return this.currentMonitorId;
  }

  private reportMonitorFallback(): void {
    const agentId = this.resolveAgentId() ?? 'no-agent';
    if (this.fallbackReported.has(agentId)) return;
    this.fallbackReported.add(agentId);
    log.warn(
      'agent stamped monitor from the turn-scoped fallback: no monitor in its async context, ' +
        'and the MCP boundary could not resolve one either. This field is slated for deletion — ' +
        'please report this line.',
      { agentId, monitorId: this.currentMonitorId },
    );
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
   * Emit an OS Action to the session it belongs to.
   *
   * `sessionId` stays optional in the signature because almost every caller runs inside an
   * agent turn or iframe verb call and the context already holds the answer. What is not
   * optional is that an answer exists.
   *
   * `monitorId` is the same override `emitActionWithFeedback` takes, for the same reason:
   * a caller that knows the target monitor better than the ambient context does. Acting on
   * a window that is not the caller's own is the case — a deploy retiring the stale windows
   * of the app it just shipped reads each one's owner off the handle map, and every one of
   * them may sit on a monitor the deploying iframe is not on. This is not the guess
   * `resolveWindowMonitor` refuses; it is the registry's own answer.
   */
  emitAction(action: OSAction, sessionId?: string, agentId?: string, monitorId?: string): void {
    const sid = this.resolveSessionId(sessionId);
    if (!sid) {
      reportUnaddressed(`action ${action.type}`);
      return;
    }
    const aid = this.resolveAgentId(agentId);
    if (this.interrupts.blocks(aid)) {
      log.info('dropping action from interrupted agent', { action: action.type, agentId: aid });
      return;
    }
    this.emit('action', {
      action,
      sessionId: sid,
      agentId: aid,
      monitorId: monitorId ?? this.monitorForAction(action, sid),
    });
  }

  /**
   * Emit an OS Action and wait for feedback from the frontend.
   *
   * The outcome distinguishes "the frontend answered" from "the frontend said nothing in
   * time", because those mean different things to different callers and only the caller
   * knows which: a lock veto that never arrives means *proceed*, an iframe that never
   * reports means *do not tell the agent it rendered*.
   */
  emitActionWithFeedback(
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
    // Get current agent ID from context and include in action
    const agentId = this.resolveAgentId();
    if (currentSessionId && this.interrupts.blocks(agentId)) {
      // Same drop as `emitAction`, settled the way an undelivered action is settled:
      // `cancelled` says the action never reached a screen, which is exactly what
      // happened, and is the one answer that cannot be read as a refusal.
      log.info('dropping action from interrupted agent', { action: action.type, agentId });
      return Promise.resolve({ ok: false, reason: 'cancelled' });
    }
    const actionWithAgent = agentId ? { ...action, agentId } : action;

    return this.renderRequests.ask({
      sessionId: currentSessionId,
      timeoutMs: clampDeadline(timeoutMs ?? deadlines.renderFeedbackMs),
      what: `action ${action.type} (awaiting feedback)`,
      send: (requestId, sid) =>
        this.emit('action', {
          action: actionWithAgent,
          requestId,
          sessionId: sid,
          agentId,
          monitorId: monitorId ?? this.monitorForAction(action, sid),
        }),
    });
  }

  /**
   * Resolve a pending request with feedback.
   * Called by the session when it receives rendering feedback from frontend.
   */
  resolveFeedback(feedback: RenderingFeedback): boolean {
    return this.renderRequests.resolve(feedback.requestId, feedback).resolved;
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
      reportUnaddressed(`session action ${action.type}`);
      return;
    }
    this.emit('session-action', {
      sessionId,
      event: { type: ServerEventType.ACTIONS, actions: [action], agentId: 'system' },
    });
  }

  /**
   * A dialog's deadline passed: take it off the screen.
   *
   * The tool that asked has already been told "denied" by then. Leaving the dialog up
   * leaves the user a live-looking question wired to nothing. Remembering that it was
   * asked is the store's job (see the grace window on {@link dialogs}).
   */
  private closeExpiredDialog(dialogId: string, sessionId: string | undefined): void {
    const close: DialogCloseAction = { type: 'dialog.close', id: dialogId, reason: 'timeout' };
    this.emitSessionAction(sessionId, close as OSAction);
  }

  /**
   * Show a confirmation dialog and wait for user response.
   *
   * An unanswered dialog is a denial — but it is an *explicit* one: the deadline
   * passes, the dialog leaves the screen, and this returns false because nobody said yes.
   */
  async showConfirmDialog(
    title: string,
    message: string,
    confirmText: string = 'Yes',
    cancelText: string = 'No',
    timeoutMs?: number,
  ): Promise<boolean> {
    const agentId = getAgentId();
    const currentSessionId = this.resolveSessionId();

    // A dialog nobody can be shown cannot be answered, and an unanswered dialog is a
    // denial — so a missing session yields the same `false` the deadline would have
    // produced, minus the wait, plus a line saying why.
    const outcome = await this.dialogs.ask({
      sessionId: currentSessionId,
      timeoutMs: clampDeadline(timeoutMs ?? deadlines.dialogMs),
      what: `confirm dialog "${title}"`,
      meta: undefined,
      onExpire: (id) => this.closeExpiredDialog(id, currentSessionId),
      send: (dialogId, sid) => {
        const action: DialogConfirmAction = {
          type: 'dialog.confirm',
          id: dialogId,
          title,
          message,
          confirmText,
          cancelText,
        };
        this.emit('action', { action: action as OSAction, sessionId: sid, agentId });
      },
    });

    return outcome.ok ? outcome.value : false;
  }

  /**
   * Show a permission dialog with "Remember my choice" option.
   *
   * Resolves the session ID from the current agent context and delegates
   * to showPermissionDialogToSession() for delivery via LiveSession.broadcast().
   */
  async showPermissionDialog(request: PermissionDialogRequest): Promise<boolean> {
    const sessionId = getSessionId();
    if (!sessionId) {
      log.warn('showPermissionDialog called without agent context');
      return false;
    }
    return this.showPermissionDialogToSession(sessionId, request);
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
    const { resolved, meta } = this.dialogs.resolve(feedback.dialogId, feedback.confirmed);
    const permissionOptions = resolved ? meta : this.dialogs.takeLate(feedback.dialogId);

    // Save permission if user chose to remember (business logic stays here, not in the store)
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
    const currentSessionId = this.resolveSessionId();
    // The old default was 300s — 45s past the transport's idle timeout, so the request
    // this prompt is holding open died before the prompt could ever report expiring.
    const timeoutMs = clampDeadline(opts.timeoutMs ?? deadlines.userPromptMs);

    const outcome = await this.userPrompts.ask({
      sessionId: currentSessionId,
      timeoutMs,
      what: `user prompt "${opts.title}"`,
      onExpire: (id) =>
        this.emitSessionAction(currentSessionId, {
          type: 'user.prompt.dismiss',
          id,
        } as UserPromptDismissAction as OSAction),
      // Deliver via dedicated event -> LiveSession.broadcast() (session-scoped, no
      // monitor filter). The monitor rides on the *action* instead, as attribution: a
      // prompt only the monitor it came from can see is a prompt nobody answers.
      send: (promptId, sid) => {
        const action: UserPromptShowAction = {
          type: 'user.prompt.show',
          id: promptId,
          title: opts.title,
          message: opts.message,
          options: opts.options,
          multiSelect: opts.multiSelect,
          inputField: opts.inputField,
          allowDismiss: opts.allowDismiss ?? true,
          monitorId: this.resolveMonitorId(),
        };
        this.emit('user-prompt', {
          sessionId: sid,
          event: {
            type: ServerEventType.ACTIONS,
            actions: [action],
            agentId: agentId ?? 'system',
          },
        });
      },
    });

    if (outcome.ok) return outcome.value;
    // Nobody answered. Say that, rather than reporting it as the user declining.
    return { dismissed: true, timedOut: outcome.reason === 'timeout' };
  }

  /**
   * Resolve a pending user prompt with feedback from the frontend.
   */
  resolveUserPromptFeedback(feedback: UserPromptFeedback): boolean {
    return this.userPrompts.resolve(feedback.promptId, {
      selectedValues: feedback.selectedValues,
      text: feedback.text,
      dismissed: feedback.dismissed ?? false,
    }).resolved;
  }

  /**
   * Ask the desktop to touch the system clipboard, and wait for what it found.
   *
   * The server has no clipboard of its own to read — see {@link UserClipboardReadAction}.
   * So this is the same server→client wait as a prompt or a capture, and it is registered
   * in `ANSWER_EVENT_TYPES` for the same reason: the answer arrives on the socket the
   * parked turn is holding, and must overtake it.
   *
   * Delivered on the session-scoped `'user-clipboard'` channel rather than `'action'`.
   * The clipboard is a property of the browser, not of a monitor, and the `'action'`
   * channel's monitor stamping would filter the read out of every connection whose tab is
   * showing a different monitor than the agent is running on.
   */
  private askDesktopForClipboard(
    build: (id: string) => UserClipboardAction,
    timeoutMs?: number,
  ): Promise<PendingOutcome<ClipboardFeedback>> {
    return this.clipboardRequests.ask({
      sessionId: this.resolveSessionId(),
      timeoutMs: clampDeadline(timeoutMs ?? deadlines.clipboardMs),
      what: 'clipboard request',
      send: (id, sid) =>
        this.emit('user-clipboard', {
          sessionId: sid,
          event: {
            type: ServerEventType.ACTIONS,
            actions: [build(id) as OSAction],
            agentId: getAgentId() ?? 'system',
          },
        }),
    });
  }

  /** Read the system clipboard, with every ceiling applied by the desktop before sending. */
  readUserClipboard(opts: {
    maxChars: number;
    image: boolean;
    maxImagePx: number;
    maxImageBytes: number;
    timeoutMs?: number;
  }): Promise<PendingOutcome<ClipboardFeedback>> {
    return this.askDesktopForClipboard(
      (id) => ({
        type: 'user.clipboard.read',
        id,
        maxChars: opts.maxChars,
        image: opts.image,
        maxImagePx: opts.maxImagePx,
        maxImageBytes: opts.maxImageBytes,
      }),
      opts.timeoutMs,
    );
  }

  /** Put text on the system clipboard. Waits so the caller can report whether it landed. */
  writeUserClipboard(text: string, timeoutMs?: number): Promise<PendingOutcome<ClipboardFeedback>> {
    return this.askDesktopForClipboard(
      (id) => ({ type: 'user.clipboard.write', id, text }),
      timeoutMs,
    );
  }

  /** Resolve a pending clipboard request with the desktop's answer. */
  resolveClipboardFeedback(feedback: ClipboardFeedback): boolean {
    return this.clipboardRequests.resolve(feedback.requestId, feedback).resolved;
  }

  /**
   * Notify that an iframe app in `sessionId` has registered with the App Protocol.
   * Resolves any pending waitForAppReady() calls for that session's window.
   *
   * The registry resolves its own waiters; the `'app-ready'` emit is the public
   * announcement of the same fact, for anything that subscribes to the channel.
   */
  notifyAppReady(sessionId: string, windowId: string): void {
    this.appReady.notify(sessionId, windowId);
    this.emit('app-ready', { sessionId, windowId } as AppReadyEvent);
  }

  /**
   * Check if an app has already signaled readiness *in this session*.
   */
  isAppReady(sessionId: string, windowId: string): boolean {
    return this.appReady.isReady(sessionId, windowId);
  }

  /** Forget one window's registration — it closed. See {@link AppReadyRegistry.forget}. */
  forgetAppReady(sessionId: string, windowId: string): void {
    this.appReady.forget(sessionId, windowId);
  }

  /**
   * Wait for an iframe app to register with the App Protocol, in the caller's session.
   * See {@link AppReadyRegistry.wait} for why `sessionId` is required and not defaulted.
   */
  waitForAppReady(
    sessionId: string | undefined,
    windowId: string,
    timeoutMs?: number,
  ): Promise<boolean> {
    return this.appReady.wait(sessionId, windowId, timeoutMs);
  }

  /**
   * Send an app protocol request to an iframe app and wait for its response.
   * The outcome is `ok: false` if the app does not answer within the deadline.
   *
   * Without a session there is no iframe to ask, so that settles as `cancelled` — the
   * caller's "the app is unreachable" branch — rather than as a deadline the frontend was
   * never given a chance to meet.
   */
  emitAppProtocolRequest(
    windowId: string,
    request: AppProtocolRequest,
    timeoutMs?: number,
    sessionId?: string,
  ): Promise<PendingOutcome<AppProtocolResponse>> {
    const deadlineMs = clampDeadline(timeoutMs ?? deadlines.appQueryMs);

    return this.appRequests.ask({
      sessionId: this.resolveSessionId(sessionId),
      timeoutMs: deadlineMs,
      what: `app protocol ${request.kind} for ${windowId}`,
      meta: { windowId, kind: request.kind, startedAt: Date.now(), timeoutMs: deadlineMs },
      // Pass the deadline to the frontend too — it relays the postMessage leg and needs
      // to know how long we are prepared to wait. It no longer times the leg itself:
      // this deadline is the only one.
      send: (requestId, sid) =>
        this.emit('app-protocol', {
          sessionId: sid,
          requestId,
          windowId,
          request,
          timeoutMs: deadlineMs,
        }),
    });
  }

  /**
   * A window closed: settle every app protocol request still addressed to it.
   *
   * Without this, a relayed command that destroys its own responder is indistinguishable
   * from a slow one. The reply can never arrive, so the ask waits out its entire deadline
   * and reports a timeout — whose standing advice is "retry with a larger timeoutMs", the
   * exact wrong move for an operation that already succeeded. The one fact that separates
   * the two cases is known here and nowhere else: the window is gone.
   *
   * Both spellings of the id, for the same reason the iframe tokens beside this call take
   * both — a request filed under the raw id (`devtools-preview-x`) and one filed under the
   * scoped handle (`0/devtools-preview-x`) are the same window, and cancelling only one
   * spelling leaves the other waiting.
   */
  cancelAppRequestsForWindow(sessionId: string, windowIds: readonly string[]): void {
    const targets = new Set(windowIds.filter(Boolean));
    if (targets.size === 0) return;
    const settled = this.appRequests.cancelWhere(
      (meta, sid) => sid === sessionId && targets.has(meta.windowId),
      'closed',
    );
    if (settled > 0) {
      appProtocolLog.debug('window closed under in-flight requests — settled as closed', {
        sessionId,
        windowIds: [...targets],
        settled,
      });
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
    const { resolved } = this.appRequests.resolve(requestId, response);
    if (resolved) return true;

    const expired = this.appRequests.takeLate(requestId);
    if (expired) {
      const latency = Date.now() - expired.startedAt;
      appProtocolLog.warn('late reply — the agent was already told the app did not respond', {
        requestId,
        kind: expired.kind,
        windowId: expired.windowId,
        latencyMs: latency,
        overdueMs: latency - expired.timeoutMs,
        timeoutMs: expired.timeoutMs,
      });
    } else {
      appProtocolLog.warn(
        'reply for unknown request — no pending entry, and none expired recently; ' +
          'duplicate reply, or a request from a dead session',
        { requestId, kind: response.kind },
      );
    }
    return false;
  }

  /**
   * Show a permission dialog targeted at a specific session via BroadcastCenter.
   *
   * Unlike showPermissionDialog() which resolves the session from the agent context,
   * this names it — used by the /api/fetch proxy route and the browser guards, where
   * there is no agent context to read one from.
   */
  async showPermissionDialogToSession(
    sessionId: string,
    request: PermissionDialogRequest,
  ): Promise<boolean> {
    const { title, message, toolName, context, capabilities } = request;

    // Check for saved permission first
    const savedDecision = await checkPermission(toolName, context);
    if (savedDecision === 'allow') return true;
    if (savedDecision === 'deny') return false;

    const permissionOptions: PermissionOptions = {
      showRememberChoice: true,
      toolName,
      context,
    };

    const outcome = await this.dialogs.ask({
      sessionId,
      timeoutMs: clampDeadline(request.timeoutMs ?? deadlines.dialogMs),
      what: `permission dialog "${title}"`,
      meta: permissionOptions,
      onExpire: (id) => this.closeExpiredDialog(id, sessionId),
      // Emit through the event system so LiveSession.broadcast() handles delivery and
      // monitor-scoped routing — the same door 'app-protocol' events go through.
      send: (dialogId, sid) =>
        this.emit('approval-request', {
          sessionId: sid,
          event: {
            type: ServerEventType.APPROVAL_REQUEST,
            dialogId,
            title,
            message,
            confirmText: request.confirmText ?? 'Allow',
            cancelText: request.cancelText ?? 'Deny',
            permissionOptions,
            ...(capabilities?.length ? { capabilities } : {}),
            agentId: getAgentId() ?? 'system',
          },
        }),
    });

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
    this.renderRequests.clearForSession(sessionId);
    this.dialogs.clearForSession(sessionId);
    this.userPrompts.clearForSession(sessionId);
    this.clipboardRequests.clearForSession(sessionId);
    this.appRequests.clearForSession(sessionId);
    this.appReady.forgetSession(sessionId);
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
