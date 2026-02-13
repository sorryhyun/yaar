/**
 * Action emitter - allows tools to emit OS Actions directly.
 *
 * This bridges the gap between MCP tool execution and the WebSocket
 * connection to the frontend. Tools emit actions here, and the agent
 * session subscribes to receive them.
 */

import { EventEmitter } from 'events';
import type {
  OSAction,
  DialogConfirmAction,
  PermissionOptions,
  AppProtocolRequest,
  AppProtocolResponse,
} from '@yaar/shared';
import { getAgentId } from '../agents/session.js';
import {
  checkPermission,
  savePermission,
  type PermissionDecision,
} from '../storage/permissions.js';

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
 * Pending request waiting for feedback.
 */
interface PendingRequest {
  resolve: (feedback: RenderingFeedback | null) => void;
  timeoutId: NodeJS.Timeout;
}

/**
 * Pending dialog waiting for feedback.
 */
interface PendingDialog {
  resolve: (confirmed: boolean) => void;
  timeoutId: NodeJS.Timeout;
  permissionOptions?: PermissionOptions;
}

/**
 * Data emitted for an app protocol request.
 */
export interface AppProtocolRequestData {
  windowId: string;
  request: AppProtocolRequest;
}

/**
 * Pending app protocol request waiting for response from iframe.
 */
interface PendingAppRequest {
  resolve: (response: AppProtocolResponse) => void;
  timeoutId: NodeJS.Timeout;
}

/**
 * Global action emitter instance.
 */
class ActionEmitter extends EventEmitter {
  private pendingRequests = new Map<string, PendingRequest>();
  private pendingDialogs = new Map<string, PendingDialog>();
  private pendingAppRequests = new Map<string, PendingAppRequest>();
  private readyWindows = new Set<string>();
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
   * Emit an OS Action to all listeners.
   */
  emitAction(action: OSAction, sessionId?: string, agentId?: string): void {
    const currentAgentId = agentId ?? getAgentId();
    this.emit('action', {
      action,
      sessionId,
      agentId: currentAgentId,
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
    // Get current agent ID from context and include in action
    const agentId = getAgentId();
    const actionWithAgent = agentId ? { ...action, agentId } : action;

    // Create promise that resolves when feedback is received or timeout
    const feedbackPromise = new Promise<RenderingFeedback | null>((resolve) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        resolve(null); // Timeout - no feedback received
      }, timeoutMs);

      this.pendingRequests.set(requestId, { resolve, timeoutId });
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
    const pending = this.pendingRequests.get(feedback.requestId);
    if (pending) {
      clearTimeout(pending.timeoutId);
      this.pendingRequests.delete(feedback.requestId);
      pending.resolve(feedback);
      return true;
    }
    return false;
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

    const dialogPromise = new Promise<boolean>((resolve) => {
      const timeoutId = setTimeout(() => {
        this.pendingDialogs.delete(dialogId);
        resolve(false); // Timeout - treat as cancel
      }, timeoutMs);

      this.pendingDialogs.set(dialogId, { resolve, timeoutId });
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
   * First checks if there's a saved permission decision. If so, returns
   * immediately with that decision. Otherwise, shows the dialog and
   * saves the decision if the user chooses to remember it.
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
    // Check for saved permission first
    const savedDecision = await checkPermission(toolName, context);
    if (savedDecision === 'allow') {
      return true;
    }
    if (savedDecision === 'deny') {
      return false;
    }

    // Show dialog with permission options
    const dialogId = `dialog-${Date.now()}-${++this.requestCounter}`;
    const agentId = getAgentId();

    const permissionOptions: PermissionOptions = {
      showRememberChoice: true,
      toolName,
      context,
    };

    const dialogPromise = new Promise<boolean>((resolve) => {
      const timeoutId = setTimeout(() => {
        this.pendingDialogs.delete(dialogId);
        resolve(false); // Timeout - treat as deny
      }, timeoutMs);

      this.pendingDialogs.set(dialogId, { resolve, timeoutId, permissionOptions });
    });

    const action: DialogConfirmAction = {
      type: 'dialog.confirm',
      id: dialogId,
      title,
      message,
      confirmText,
      cancelText,
      permissionOptions,
    };

    this.emit('action', {
      action: action as OSAction,
      sessionId: undefined,
      agentId,
    } as ActionEvent);

    return dialogPromise;
  }

  /**
   * Resolve a pending dialog with feedback.
   */
  async resolveDialogFeedback(feedback: DialogFeedback): Promise<boolean> {
    const pending = this.pendingDialogs.get(feedback.dialogId);
    if (pending) {
      clearTimeout(pending.timeoutId);
      this.pendingDialogs.delete(feedback.dialogId);

      // Save permission if user chose to remember
      if (pending.permissionOptions && feedback.rememberChoice) {
        const { toolName, context } = pending.permissionOptions;
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

      pending.resolve(feedback.confirmed);
      return true;
    }
    return false;
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

    const responsePromise = new Promise<AppProtocolResponse | null>((resolve) => {
      const timeoutId = setTimeout(() => {
        this.pendingAppRequests.delete(requestId);
        resolve(null);
      }, timeoutMs);

      this.pendingAppRequests.set(requestId, { resolve, timeoutId });
    });

    this.emit('app-protocol', { requestId, windowId, request });

    return responsePromise;
  }

  /**
   * Resolve a pending app protocol request with a response from the iframe.
   * Called by the session when it receives an APP_PROTOCOL_RESPONSE from the frontend.
   */
  resolveAppProtocolResponse(requestId: string, response: AppProtocolResponse): boolean {
    const pending = this.pendingAppRequests.get(requestId);
    if (pending) {
      clearTimeout(pending.timeoutId);
      this.pendingAppRequests.delete(requestId);
      pending.resolve(response);
      return true;
    }
    return false;
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
