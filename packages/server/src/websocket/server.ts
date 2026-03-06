/**
 * WebSocket handlers for Bun.serve() with LiveSession join protocol.
 *
 * Multiple WebSocket connections can join the same LiveSession.
 * New connections receive a snapshot of current window state.
 */

import type { ServerWebSocket } from 'bun';
import { getSessionHub, type LiveSessionOptions } from '../session/live-session.js';
import { getWarmPool } from '../providers/factory.js';
import { getBroadcastCenter, generateConnectionId } from '../session/broadcast-center.js';
import { ServerEventType, type ClientEvent, type OSAction } from '@yaar/shared';
import type { ContextMessage } from '../agents/context.js';
import { checkWsAuth } from '../http/auth.js';

export interface WebSocketServerOptions {
  restoreActions: OSAction[];
  contextMessages: ContextMessage[];
  savedThreadIds?: Record<string, string>;
}

export interface WsData {
  connectionId: string;
  sessionId: string | null;
  monitorId: string | null;
}

export function createWsHandlers(options: WebSocketServerOptions) {
  return {
    async open(ws: ServerWebSocket<WsData>) {
      const { connectionId } = ws.data;
      const broadcastCenter = getBroadcastCenter();

      // Get or create session
      const hub = getSessionHub();
      const sessionOptions: LiveSessionOptions = {
        restoreActions: options.restoreActions,
        contextMessages: options.contextMessages,
        savedThreadIds: options.savedThreadIds,
      };
      const requestedSessionId = ws.data.sessionId;
      const session = hub.getOrCreate(requestedSessionId, sessionOptions);
      hub.cancelEviction(session.sessionId);

      // Update ws.data with the actual session ID (may differ from requested)
      ws.data.sessionId = session.sessionId;

      // Register connection with session and broadcast center
      // Bun's ServerWebSocket has the same send/readyState API as our YaarWebSocket
      session.addConnection(connectionId, ws);
      broadcastCenter.subscribe(connectionId, ws, session.sessionId);

      // Auto-subscribe to monitor if specified in query params
      const monitorId = ws.data.monitorId;
      if (monitorId) {
        broadcastCenter.subscribeToMonitor(connectionId, monitorId);
      }

      console.log(`WebSocket client connected: ${connectionId} → session ${session.sessionId}`);

      // Send connection status to this connection only
      session.sendTo(connectionId, {
        type: ServerEventType.CONNECTION_STATUS,
        status: 'connected',
        provider: getWarmPool().getPreferredProvider() ?? 'claude',
        sessionId: session.sessionId,
      });

      // Send snapshot of current windows to new connection
      const snapshotActions = session.generateSnapshot();
      if (snapshotActions.length > 0) {
        session.sendTo(connectionId, { type: ServerEventType.ACTIONS, actions: snapshotActions });
      }

      // Execute launch hooks for fresh sessions (not reconnections)
      if (!requestedSessionId) {
        session.executeLaunchHooks(connectionId).catch((err) => {
          console.error('Failed to execute launch hooks:', err);
        });
      }
    },

    async message(ws: ServerWebSocket<WsData>, data: string | Buffer) {
      const { connectionId, sessionId } = ws.data;
      try {
        const event = JSON.parse(typeof data === 'string' ? data : data.toString()) as ClientEvent;
        const hub = getSessionHub();
        const session = hub.get(sessionId!);
        if (session) {
          await session.routeMessage(event, connectionId);
        }
      } catch (err) {
        console.error('Failed to process message:', err);
      }
    },

    close(ws: ServerWebSocket<WsData>) {
      const { connectionId, sessionId } = ws.data;
      console.log(`WebSocket client disconnected: ${connectionId}`);

      const hub = getSessionHub();
      const session = hub.get(sessionId!);
      if (session) {
        session.removeConnection(connectionId);
        if (!session.hasConnections()) {
          hub.scheduleEviction(session.sessionId);
        }
      }
      getBroadcastCenter().unsubscribe(connectionId);
      // Session stays alive for reconnection; evicted after timeout if no one reconnects
    },
  };
}

/**
 * Prepare WsData from the upgrade request.
 * Called in the fetch handler before server.upgrade().
 */
export function prepareWsData(url: URL): { authorized: boolean; data: WsData } {
  if (!checkWsAuth(url)) {
    return {
      authorized: false,
      data: { connectionId: '', sessionId: null, monitorId: null },
    };
  }

  return {
    authorized: true,
    data: {
      connectionId: generateConnectionId(),
      sessionId: url.searchParams.get('sessionId'),
      monitorId: url.searchParams.get('monitorId'),
    },
  };
}
