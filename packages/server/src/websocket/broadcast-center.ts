/**
 * BroadcastCenter - Centralized event hub for routing events to WebSocket connections.
 *
 * Decouples agents from WebSocket connections, allowing:
 * - Agents to send events without holding WebSocket references
 * - Connection lifecycle management separate from agent lifecycle
 * - Centralized event routing and logging
 * - Session-aware broadcasting to all connections in a session
 */

import type { WebSocket } from 'ws';
import type { ServerEvent } from '@yaar/shared';
import type { SessionId } from '../session/types.js';

export type ConnectionId = string;

interface ConnectionEntry {
  ws: WebSocket;
  sessionId: SessionId;
}

export class BroadcastCenter {
  private connections: Map<ConnectionId, ConnectionEntry> = new Map();

  /**
   * Register a WebSocket connection with its session.
   */
  subscribe(connectionId: ConnectionId, ws: WebSocket, sessionId: SessionId): void {
    this.connections.set(connectionId, { ws, sessionId });
    console.log(`[BroadcastCenter] Connection subscribed: ${connectionId} (session: ${sessionId})`);
  }

  /**
   * Unregister a WebSocket connection.
   */
  unsubscribe(connectionId: ConnectionId): void {
    this.connections.delete(connectionId);
    console.log(`[BroadcastCenter] Connection unsubscribed: ${connectionId}`);
  }

  /**
   * Check if a connection is still active.
   */
  isConnectionActive(connectionId: ConnectionId): boolean {
    const entry = this.connections.get(connectionId);
    return entry !== undefined && entry.ws.readyState === entry.ws.OPEN;
  }

  /**
   * Publish an event directly to a single connection.
   * Returns true if the event was sent successfully.
   */
  publishToConnection(event: ServerEvent, connectionId: ConnectionId): boolean {
    const entry = this.connections.get(connectionId);
    if (!entry || entry.ws.readyState !== entry.ws.OPEN) {
      console.warn(`[BroadcastCenter] Connection not available: ${connectionId}`);
      return false;
    }

    try {
      entry.ws.send(JSON.stringify(event));
      return true;
    } catch (err) {
      console.error(`[BroadcastCenter] Failed to send event to ${connectionId}:`, err);
      return false;
    }
  }

  /**
   * Publish an event to all connections belonging to a session.
   * Returns the number of connections that received the event.
   */
  publishToSession(sessionId: SessionId, event: ServerEvent): number {
    let count = 0;
    const data = JSON.stringify(event);
    for (const [, entry] of this.connections) {
      if (entry.sessionId === sessionId && entry.ws.readyState === entry.ws.OPEN) {
        try {
          entry.ws.send(data);
          count++;
        } catch (err) {
          console.error(`[BroadcastCenter] Failed to send session event:`, err);
        }
      }
    }
    return count;
  }

  /**
   * Broadcast an event to all connections (all sessions).
   * Returns the number of connections that received the event.
   */
  broadcast(event: ServerEvent): number {
    let count = 0;
    const data = JSON.stringify(event);
    for (const [, entry] of this.connections) {
      if (entry.ws.readyState === entry.ws.OPEN) {
        try {
          entry.ws.send(data);
          count++;
        } catch (err) {
          console.error(`[BroadcastCenter] Failed to broadcast:`, err);
        }
      }
    }
    return count;
  }

  /**
   * Get stats for monitoring.
   */
  getStats(): { connectionCount: number } {
    return {
      connectionCount: this.connections.size,
    };
  }

  /**
   * Clear all connections (for testing/shutdown).
   */
  clear(): void {
    this.connections.clear();
  }
}

// Global singleton instance
let globalBroadcastCenter: BroadcastCenter | null = null;

/**
 * Get the global broadcast center instance.
 */
export function getBroadcastCenter(): BroadcastCenter {
  if (!globalBroadcastCenter) {
    globalBroadcastCenter = new BroadcastCenter();
  }
  return globalBroadcastCenter;
}

/**
 * Reset the global broadcast center (for testing).
 */
export function resetBroadcastCenter(): void {
  if (globalBroadcastCenter) {
    globalBroadcastCenter.clear();
  }
  globalBroadcastCenter = null;
}

/**
 * Generate a unique connection ID.
 */
export function generateConnectionId(): ConnectionId {
  return `conn-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
