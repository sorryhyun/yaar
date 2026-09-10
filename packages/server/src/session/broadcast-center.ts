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

/**
 * How many bytes may sit unsent on one connection before we stop feeding it.
 *
 * Every server→client event is an OS Action or a stream delta: a state transition the
 * client's view of the desktop depends on. That rules out the usual backpressure answers.
 * *Dropping* one event keeps the socket alive but silently desynchronizes it — a client
 * that misses a `window.create` shows a desktop that no longer matches the session, with
 * nothing to reveal the divergence. *Coalescing* needs to know which events supersede which,
 * which is per-event-type knowledge this hub deliberately does not have.
 *
 * So the policy is: never drop an event on a connection we keep open, and close a connection
 * that has fallen this far behind. A close is recoverable in a way a dropped action is not —
 * the frontend reconnects on any close code other than 1000
 * (`use-agent-connection/transport-manager.ts`), re-attaches to the same session, and
 * re-syncs window state from `SessionSnapshotService`. The session itself is untouched;
 * sessions outlive their sockets by design.
 *
 * 8MB is chosen to be far above normal traffic and below unbounded: the largest single
 * payloads are monitor screenshots and rasterized PDF pages, a few MB at worst, and a
 * client that is draining at all stays orders of magnitude under this. Tripping it means the
 * peer has stopped reading, not that it is briefly slow.
 *
 * It also sits deliberately *below* Bun's own `backpressureLimit` (16MB), so this policy —
 * with its close code and its log line — is what fires, rather than Bun's
 * `closeOnBackpressureLimit`, which defaults to off and would otherwise let the queue grow
 * without bound. Measured against a peer that stops reading: `getBufferedAmount()` climbs
 * past 17MB while `send()` returns -1, and nothing closes the socket.
 */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

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
  /**
   * Set once this connection has been closed for falling behind, so a burst still in
   * flight neither calls `close()` repeatedly nor logs once per event. The entry is
   * removed for real when the socket's close handler calls `unsubscribe`.
   */
  overflowed?: boolean;
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
   * Send one already-serialized payload to one connection, applying the send budget.
   *
   * The single place any event reaches a socket, so the budget cannot be bypassed by a
   * caller and the four publish methods do not each repeat the `readyState`/try-catch dance.
   * Returns whether the payload was handed to the socket.
   *
   * The check is *before* the send, not after: once a peer has stopped reading, adding to
   * the queue is what we are trying to avoid, and the event we are holding is no more
   * droppable than the ones already queued — so the connection goes instead.
   */
  private deliver(connectionId: ConnectionId, entry: ConnectionEntry, data: string): boolean {
    if (entry.overflowed || entry.ws.readyState !== WS_OPEN) return false;

    // Bun's ServerWebSocket answers `getBufferedAmount()`; `ws`/client sockets carry a
    // `bufferedAmount` property. `undefined` from both means the socket does not report a
    // queue depth (a test fake), and a socket with no opinion is never over budget.
    const buffered = entry.ws.getBufferedAmount?.() ?? entry.ws.bufferedAmount;
    if (buffered !== undefined && buffered > MAX_BUFFERED_BYTES) {
      entry.overflowed = true;
      log.warn('connection fell behind; closing so it reconnects and re-syncs', {
        connectionId,
        sessionId: entry.sessionId,
        bufferedBytes: buffered,
        limitBytes: MAX_BUFFERED_BYTES,
      });
      // 1013 "Try Again Later" — anything but 1000 makes the frontend reconnect.
      entry.ws.close?.(1013, 'send buffer exceeded');
      return false;
    }

    try {
      entry.ws.send(data);
      return true;
    } catch (err) {
      log.error('failed to send event', { connectionId, sessionId: entry.sessionId, err });
      return false;
    }
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
    return this.deliver(connectionId, entry, JSON.stringify(event));
  }

  /**
   * Publish an event to all connections belonging to a session.
   * Returns the number of connections that received the event.
   */
  publishToSession(sessionId: SessionId, event: ServerEvent): number {
    let count = 0;
    const data = JSON.stringify(event);
    for (const [connectionId, entry] of this.connections) {
      if (entry.sessionId !== sessionId) continue;
      if (this.deliver(connectionId, entry, data)) count++;
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
    for (const [connectionId, entry] of this.connections) {
      if (entry.sessionId !== sessionId || entry.monitorId !== monitorId) continue;
      if (this.deliver(connectionId, entry, data)) count++;
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
    for (const [connectionId, entry] of this.connections) {
      if (this.deliver(connectionId, entry, data)) count++;
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
