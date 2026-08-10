/**
 * BroadcastCenter - Centralized event hub for routing events to WebSocket connections.
 *
 * Decouples agents from WebSocket connections, allowing:
 * - Agents to send events without holding WebSocket references
 * - Connection lifecycle management separate from agent lifecycle
 * - Centralized event routing and logging
 * - Session-aware broadcasting to all connections in a session
 */

import type { ServerEvent } from '@yaar/shared';
import type { SessionId } from './types.js';
import { type YaarWebSocket, WS_OPEN } from './types.js';
import { genId } from '../lib/ids.js';
import { createLogger } from '../observability/log.js';

const log = createLogger('BroadcastCenter');

export type ConnectionId = string;

interface ConnectionEntry {
  ws: YaarWebSocket;
  sessionId: SessionId;
  /**
   * The one monitor this connection is looking at, or undefined before it has said.
   *
   * A Set here was the bug: subscribing only ever added, nothing ever removed, and a
   * connection that switched monitors kept receiving the old one's events forever —
   * including a monitor it had *deleted*, whose windows the frontend then re-created.
   * A tab looks at one monitor at a time, so this holds one monitor.
   */
  monitorId?: string;
}

export class BroadcastCenter {
  private connections: Map<ConnectionId, ConnectionEntry> = new Map();

  /**
   * Register a WebSocket connection with its session.
   */
  subscribe(connectionId: ConnectionId, ws: YaarWebSocket, sessionId: SessionId): void {
    this.connections.set(connectionId, { ws, sessionId });
    log.info('connection subscribed', { connectionId, sessionId });
  }

  /**
   * Unregister a WebSocket connection.
   */
  unsubscribe(connectionId: ConnectionId): void {
    this.connections.delete(connectionId);
    log.info('connection unsubscribed', { connectionId });
  }

  /**
   * Point a connection at a monitor, replacing whatever it was looking at.
   *
   * A connection receives monitor-scoped events for exactly this monitor and no
   * other. Until it has been called, the connection receives none: "no monitor" is
   * not "every monitor", it is a connection that has not yet said where it is.
   */
  subscribeToMonitor(connectionId: ConnectionId, monitorId: string): void {
    const entry = this.connections.get(connectionId);
    if (entry) {
      // Only a *change* is worth a line — clients re-assert their current monitor
      // often enough that logging every call drowns the console.
      const changed = entry.monitorId !== monitorId;
      entry.monitorId = monitorId;
      if (changed) {
        log.info('connection subscribed to monitor', { connectionId, monitorId });
      }
    }
  }

  /** The monitor a connection is watching, or undefined if it has not said yet. */
  monitorOf(connectionId: ConnectionId): string | undefined {
    return this.connections.get(connectionId)?.monitorId;
  }

  /**
   * Detach every connection in a session that is watching a now-deleted monitor.
   *
   * Without this, REMOVE_MONITOR tore down the agent and left the subscription —
   * so a deleted monitor kept delivering, and the frontend faithfully re-created
   * the windows of a desktop the user had just closed.
   */
  unsubscribeMonitor(sessionId: SessionId, monitorId: string): void {
    for (const [connectionId, entry] of this.connections) {
      if (entry.sessionId === sessionId && entry.monitorId === monitorId) {
        entry.monitorId = undefined;
        log.info('connection detached from removed monitor', { connectionId, monitorId });
      }
    }
  }

  /**
   * Check if a connection is still active.
   */
  isConnectionActive(connectionId: ConnectionId): boolean {
    const entry = this.connections.get(connectionId);
    return entry !== undefined && entry.ws.readyState === WS_OPEN;
  }

  /**
   * Publish an event directly to a single connection.
   * Returns true if the event was sent successfully.
   */
  publishToConnection(event: ServerEvent, connectionId: ConnectionId): boolean {
    const entry = this.connections.get(connectionId);
    if (!entry || entry.ws.readyState !== WS_OPEN) {
      log.warn('connection not available', { connectionId });
      return false;
    }

    try {
      entry.ws.send(JSON.stringify(event));
      return true;
    } catch (err) {
      log.error('failed to send event to connection', { connectionId, err });
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
      if (entry.sessionId === sessionId && entry.ws.readyState === WS_OPEN) {
        try {
          entry.ws.send(data);
          count++;
        } catch (err) {
          log.error('failed to send session event', { sessionId, err });
        }
      }
    }
    return count;
  }

  /**
   * Publish an event to the connections in a session that are watching this monitor.
   * Returns the number of connections that received the event.
   */
  publishToMonitor(sessionId: SessionId, monitorId: string, event: ServerEvent): number {
    let count = 0;
    const data = JSON.stringify(event);
    for (const [, entry] of this.connections) {
      if (
        entry.sessionId === sessionId &&
        entry.monitorId === monitorId &&
        entry.ws.readyState === WS_OPEN
      ) {
        try {
          entry.ws.send(data);
          count++;
        } catch (err) {
          log.error('failed to send monitor event', { sessionId, monitorId, err });
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
      if (entry.ws.readyState === WS_OPEN) {
        try {
          entry.ws.send(data);
          count++;
        } catch (err) {
          log.error('failed to broadcast', { err });
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
  return genId('conn', 7);
}
