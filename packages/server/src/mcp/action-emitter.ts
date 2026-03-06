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
  type PermissionOptions,
  type AppProtocolRequest,
  type AppProtocolResponse,
  type UserPromptShowAction,
  type UserPromptOption,
  type UserPromptInputField,
} from '@yaar/shared';
import { getAgentId, getSessionId } from '../agents/session.js';
import {
  checkPermission,
  savePermission,
  type PermissionDecision,
} from '../storage/permissions.js';
import { PendingStore } from './pending-store.js';

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
 */
export interface UserPromptResult {
  selectedValues?: string[];
  text?: string;
  dismissed: boolean;
}

/**
 * Data emitted for an app protocol request.
 */
export interface AppProtocolRequestData {
  windowId: string;
  request: AppProtocolRequest;
}

/**
 * Global action emitter instance.
 */
class ActionEmitter extends EventEmitter {
  private pendingRequests = new PendingStore<RenderingFeedback | null>();
  private pendingDialogs = new PendingStore<boolean, PermissionOptions | undefined>();
  private pendingUserPrompts = new PendingStore<UserPromptResult>();
  private pendingAppRequests = new PendingStore<AppProtocolResponse | null>();
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
   * Emit an OS Action to all listeners.
   */
  emitAction(action: OSAction, sessionId?: string, agentId?: string): void {
    this.emit('action', {
      action,
      sessionId,
      agentId: this.resolveAgentId(agentId),
      monitorId: this.currentMonitorId,
    } as ActionEvent);
  }

  /**
   * Emit an OS Action and wait for feedback from frontend.
   * Used for iframe rendering where we want to know if it succeeded.
   * Automatically includes the current agent's ID from context.
   */
  async emitActionWithFeedback(
    action: OSAction,
    timeoutMs: number = 3000,
    sessionId?: string,
  ): Promise<RenderingFeedback | null> {
    const requestId = this.generateRequestId();
    // Get current agent ID from context (with Codex fallback) and include in action
    const agentId = this.resolveAgentId();
    const actionWithAgent = agentId ? { ...action, agentId } : action;

    const currentSessionId = sessionId ?? getSessionId();
    const feedbackPromise = this.pendingRequests.create(requestId, {
      timeoutMs,
      sessionId: currentSessionId,
      defaultValue: null,
    });

    // Emit action with request ID, agentId from context, and monitorId
    this.emit('action', {
      action: actionWithAgent,
      requestId,
      sessionId,
      agentId,
      monitorId: this.currentMonitorId,
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
   * Show a confirmation dialog and wait for user response.
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
      timeoutMs,
      sessionId: currentSessionId,
      defaultValue: false,
      meta: undefined,
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

    return dialogPromise;
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
   */
  async resolveDialogFeedback(feedback: DialogFeedback): Promise<boolean> {
    const { resolved, meta: permissionOptions } = this.pendingDialogs.resolve(
      feedback.dialogId,
      feedback.confirmed,
    );

    // Save permission if user chose to remember (business logic stays here, not in PendingStore)
    if (resolved && permissionOptions && feedback.rememberChoice) {
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
    const timeoutMs = opts.timeoutMs ?? 300000; // 5 minutes default

    const promptPromise = this.pendingUserPrompts.create(promptId, {
      timeoutMs,
      sessionId: currentSessionId,
      defaultValue: { dismissed: true },
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

    return promptPromise;
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
   * Returns null if the app does not respond within the timeout.
   */
  async emitAppProtocolRequest(
    windowId: string,
    request: AppProtocolRequest,
    timeoutMs: number = 5000,
  ): Promise<AppProtocolResponse | null> {
    const requestId = this.generateRequestId();
    const currentSessionId = getSessionId();

    const responsePromise = this.pendingAppRequests.create(requestId, {
      timeoutMs,
      sessionId: currentSessionId,
      defaultValue: null,
    });

    this.emit('app-protocol', { requestId, windowId, request });

    return responsePromise;
  }

  /**
   * Resolve a pending app protocol request with a response from the iframe.
   * Called by the session when it receives an APP_PROTOCOL_RESPONSE from the frontend.
   */
  resolveAppProtocolResponse(requestId: string, response: AppProtocolResponse): boolean {
    return this.pendingAppRequests.resolve(requestId, response).resolved;
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
      timeoutMs,
      sessionId,
      defaultValue: false,
      meta: permissionOptions,
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

    return dialogPromise;
  }

  /**
   * Force-clear all pending requests, dialogs, and app protocol requests
   * belonging to a session. Rejects promises so awaiting tools unblock
   * immediately instead of waiting for their individual timeouts.
   */
  clearPendingForSession(sessionId: string): void {
    this.pendingRequests.clearForSession(sessionId, null);
    this.pendingDialogs.clearForSession(sessionId, false);
    this.pendingUserPrompts.clearForSession(sessionId, { dismissed: true });
    this.pendingAppRequests.clearForSession(sessionId, null as unknown as AppProtocolResponse);
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
