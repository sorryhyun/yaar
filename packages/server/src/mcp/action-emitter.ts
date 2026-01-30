/**
 * Action emitter - allows tools to emit OS Actions directly.
 *
 * This bridges the gap between MCP tool execution and the WebSocket
 * connection to the frontend. Tools emit actions here, and the agent
 * session subscribes to receive them.
 */

import { EventEmitter } from 'events';
import type { OSAction } from '@claudeos/shared';
import { getAgentId } from '../agents/session.js';

/**
 * Action event data.
 */
export interface ActionEvent {
  action: OSAction;
  requestId?: string;
  sessionId?: string;
  agentId?: string;
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
}

/**
 * Pending request waiting for feedback.
 */
interface PendingRequest {
  resolve: (feedback: RenderingFeedback | null) => void;
  timeoutId: NodeJS.Timeout;
}

/**
 * Global action emitter instance.
 */
class ActionEmitter extends EventEmitter {
  private pendingRequests = new Map<string, PendingRequest>();
  private requestCounter = 0;

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
    this.emit('action', { action, sessionId, agentId } as ActionEvent);
  }

  /**
   * Emit an OS Action and wait for feedback from frontend.
   * Used for iframe rendering where we want to know if it succeeded.
   * Automatically includes the current agent's ID from context.
   */
  async emitActionWithFeedback(
    action: OSAction,
    timeoutMs: number = 3000,
    sessionId?: string
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

    // Emit action with request ID and agentId from context
    this.emit('action', { action: actionWithAgent, requestId, sessionId, agentId } as ActionEvent);

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
