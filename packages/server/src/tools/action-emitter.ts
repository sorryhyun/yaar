/**
 * Action emitter - allows tools to emit OS Actions directly.
 *
 * This bridges the gap between MCP tool execution and the WebSocket
 * connection to the frontend. Tools emit actions here, and the agent
 * session subscribes to receive them.
 */

import { EventEmitter } from 'events';
import type { OSAction } from '@claudeos/shared';

/**
 * Action event data.
 */
export interface ActionEvent {
  action: OSAction;
  sessionId?: string;
}

/**
 * Global action emitter instance.
 */
class ActionEmitter extends EventEmitter {
  /**
   * Emit an OS Action to all listeners.
   */
  emitAction(action: OSAction, sessionId?: string): void {
    this.emit('action', { action, sessionId } as ActionEvent);
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
