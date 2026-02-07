/**
 * BroadcastCenter - Centralized event hub for routing events to WebSocket connections.
 *
 * Decouples agents from WebSocket connections, allowing:
 * - Agents to send events without holding WebSocket references
 * - Connection lifecycle management separate from agent lifecycle
 * - Centralized event routing and logging
 */

import type { WebSocket } from 'ws';
import type { ServerEvent } from '@yaar/shared';

export type ConnectionId = string;

export class BroadcastCenter {
  private connections: Map<ConnectionId, WebSocket> = new Map();

  /**
   * Register a WebSocket connection.
   */
  subscribe(connectionId: ConnectionId, ws: WebSocket): void {
    this.connections.set(connectionId, ws);
    console.log(`[BroadcastCenter] Connection subscribed: ${connectionId}`);
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
    const ws = this.connections.get(connectionId);
    return ws !== undefined && ws.readyState === ws.OPEN;
  }

  /**
   * Publish an event directly to a connection.
   * Returns true if the event was sent successfully.
   */
  publishToConnection(event: ServerEvent, connectionId: ConnectionId): boolean {
    const ws = this.connections.get(connectionId);
    if (!ws || ws.readyState !== ws.OPEN) {
      console.warn(`[BroadcastCenter] Connection not available: ${connectionId}`);
      return false;
    }

    try {
      ws.send(JSON.stringify(event));
      return true;
    } catch (err) {
      console.error(`[BroadcastCenter] Failed to send event to ${connectionId}:`, err);
      return false;
    }
  }

  /**
   * Broadcast an event to all connections.
   * Returns the number of connections that received the event.
   */
  broadcast(event: ServerEvent): number {
    let count = 0;
    for (const [connectionId] of this.connections) {
      if (this.publishToConnection(event, connectionId)) {
        count++;
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
