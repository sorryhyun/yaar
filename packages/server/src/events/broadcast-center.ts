/**
 * BroadcastCenter - Centralized event hub for routing agent events to WebSocket connections.
 *
 * Decouples agents from WebSocket connections, allowing:
 * - Agents to send events without holding WebSocket references
 * - Connection lifecycle management separate from agent lifecycle
 * - Centralized event routing and logging
 */

import type { WebSocket } from 'ws';
import type { ServerEvent } from '@claudeos/shared';

export type ConnectionId = string;

export class BroadcastCenter {
  private connections: Map<ConnectionId, WebSocket> = new Map();
  private agentToConnection: Map<string, ConnectionId> = new Map();

  /**
   * Register a WebSocket connection.
   */
  subscribe(connectionId: ConnectionId, ws: WebSocket): void {
    this.connections.set(connectionId, ws);
    console.log(`[BroadcastCenter] Connection subscribed: ${connectionId}`);
  }

  /**
   * Unregister a WebSocket connection and clean up associated agents.
   */
  unsubscribe(connectionId: ConnectionId): void {
    this.connections.delete(connectionId);

    // Clean up agent mappings for this connection
    const agentsToRemove: string[] = [];
    for (const [agentId, connId] of this.agentToConnection.entries()) {
      if (connId === connectionId) {
        agentsToRemove.push(agentId);
      }
    }
    for (const agentId of agentsToRemove) {
      this.agentToConnection.delete(agentId);
    }

    console.log(
      `[BroadcastCenter] Connection unsubscribed: ${connectionId}, ` +
        `cleaned up ${agentsToRemove.length} agent(s)`
    );
  }

  /**
   * Register an agent with a connection.
   */
  registerAgent(agentId: string, connectionId: ConnectionId): void {
    this.agentToConnection.set(agentId, connectionId);
  }

  /**
   * Unregister an agent.
   */
  unregisterAgent(agentId: string): void {
    this.agentToConnection.delete(agentId);
  }

  /**
   * Get the connection ID for an agent.
   */
  getConnectionForAgent(agentId: string): ConnectionId | undefined {
    return this.agentToConnection.get(agentId);
  }

  /**
   * Check if a connection is still active.
   */
  isConnectionActive(connectionId: ConnectionId): boolean {
    const ws = this.connections.get(connectionId);
    return ws !== undefined && ws.readyState === ws.OPEN;
  }

  /**
   * Publish an event to the connection associated with an agent.
   * Returns true if the event was sent successfully.
   */
  publishToAgent(event: ServerEvent, agentId: string): boolean {
    const connectionId = this.agentToConnection.get(agentId);
    if (!connectionId) {
      console.warn(`[BroadcastCenter] No connection for agent: ${agentId}`);
      return false;
    }
    return this.publishToConnection(event, connectionId);
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
  getStats(): {
    connectionCount: number;
    agentCount: number;
  } {
    return {
      connectionCount: this.connections.size,
      agentCount: this.agentToConnection.size,
    };
  }

  /**
   * Get all registered agents for a connection.
   */
  getAgentsForConnection(connectionId: ConnectionId): string[] {
    const agents: string[] = [];
    for (const [agentId, connId] of this.agentToConnection.entries()) {
      if (connId === connectionId) {
        agents.push(agentId);
      }
    }
    return agents;
  }

  /**
   * Clear all connections and agents (for testing/shutdown).
   */
  clear(): void {
    this.connections.clear();
    this.agentToConnection.clear();
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
