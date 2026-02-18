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
import type { SessionId } from './types.js';

export type ConnectionId = string;

interface ConnectionEntry {
  ws: WebSocket;
  sessionId: SessionId;
  subscribedMonitors: Set<string>;
}

export class BroadcastCenter {
  private connections: Map<ConnectionId, ConnectionEntry> = new Map();

  /**
   * Register a WebSocket connection with its session.
   */
  subscribe(connectionId: ConnectionId, ws: WebSocket, sessionId: SessionId): void {
    this.connections.set(connectionId, { ws, sessionId, subscribedMonitors: new Set() });
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
   * Subscribe a connection to a specific monitor.
   * Connections with subscriptions only receive monitor-scoped events for subscribed monitors.
   * Connections with no subscriptions receive all events (backward compat).
   */
  subscribeToMonitor(connectionId: ConnectionId, monitorId: string): void {
    const entry = this.connections.get(connectionId);
    if (entry) {
      entry.subscribedMonitors.add(monitorId);
      console.log(
        `[BroadcastCenter] Connection ${connectionId} subscribed to monitor ${monitorId}`,
      );
    }
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
   * Publish an event to connections in a session that are subscribed to a specific monitor.
   * Connections with empty subscribedMonitors receive all events (backward compat).
   * Returns the number of connections that received the event.
   */
  publishToMonitor(sessionId: SessionId, monitorId: string, event: ServerEvent): number {
    let count = 0;
    const data = JSON.stringify(event);
    for (const [, entry] of this.connections) {
      if (entry.sessionId === sessionId && entry.ws.readyState === entry.ws.OPEN) {
        // Send if: no subscriptions (backward compat) OR subscribed to this monitor
        if (entry.subscribedMonitors.size === 0 || entry.subscribedMonitors.has(monitorId)) {
          try {
            entry.ws.send(data);
            count++;
          } catch (err) {
            console.error(`[BroadcastCenter] Failed to send monitor event:`, err);
          }
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
   * Get any active session ID from connections.
   * Returns the first open session found, or undefined if none.
   */
  getAnySessionId(): SessionId | undefined {
    for (const [, entry] of this.connections) {
      if (entry.ws.readyState === entry.ws.OPEN) {
        return entry.sessionId;
      }
    }
    return undefined;
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
