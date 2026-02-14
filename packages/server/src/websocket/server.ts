/**
 * WebSocket server factory with LiveSession join protocol.
 *
 * Multiple WebSocket connections can join the same LiveSession.
 * New connections receive a snapshot of current window state.
 */

import type { Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { getSessionHub, type LiveSessionOptions } from '../session/live-session.js';
import { getWarmPool } from '../providers/factory.js';
import { getBroadcastCenter, generateConnectionId } from '../session/broadcast-center.js';
import type { ClientEvent, OSAction } from '@yaar/shared';
import type { ContextMessage } from '../agents/context.js';
import { getHooksByEvent } from '../mcp/system/hooks.js';
import { checkWsAuth } from '../http/auth.js';

export interface WebSocketServerOptions {
  restoreActions: OSAction[];
  contextMessages: ContextMessage[];
  savedThreadIds?: Record<string, string>;
}

export function createWebSocketServer(
  httpServer: Server,
  options: WebSocketServerOptions,
): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', async (ws: WebSocket, req) => {
    const connectionId = generateConnectionId();
    const broadcastCenter = getBroadcastCenter();

    // Parse requested session ID from query params (for reconnection)
    const url = new URL(req.url!, `http://${req.headers.host}`);

    // Auth check for remote mode
    if (!checkWsAuth(url)) {
      ws.close(4401, 'Unauthorized');
      return;
    }

    const requestedSessionId = url.searchParams.get('sessionId');

    // Get or create session
    const hub = getSessionHub();
    const sessionOptions: LiveSessionOptions = {
      restoreActions: options.restoreActions,
      contextMessages: options.contextMessages,
      savedThreadIds: options.savedThreadIds,
    };
    const session = hub.getOrCreate(requestedSessionId, sessionOptions);

    // Register connection with session and broadcast center
    session.addConnection(connectionId, ws);
    broadcastCenter.subscribe(connectionId, ws, session.sessionId);

    // Auto-subscribe to monitor if specified in query params
    const monitorId = url.searchParams.get('monitorId');
    if (monitorId) {
      broadcastCenter.subscribeToMonitor(connectionId, monitorId);
    }

    console.log(`WebSocket client connected: ${connectionId} → session ${session.sessionId}`);

    // Send connection status to this connection only
    session.sendTo(connectionId, {
      type: 'CONNECTION_STATUS',
      status: 'connected',
      provider: getWarmPool().getPreferredProvider() ?? 'claude',
      sessionId: session.sessionId,
    });

    // Send snapshot of current windows to new connection
    const snapshotActions = session.generateSnapshot();
    if (snapshotActions.length > 0) {
      session.sendTo(connectionId, { type: 'ACTIONS', actions: snapshotActions });
    }

    // Execute launch hooks for fresh sessions (not reconnections)
    if (!requestedSessionId && !session.launchHooksExecuted) {
      session.launchHooksExecuted = true;
      getHooksByEvent('launch')
        .then(async (hooks) => {
          for (const hook of hooks) {
            if (hook.action.type === 'interaction') {
              const messageId = `hook-${hook.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
              await session.routeMessage(
                { type: 'USER_MESSAGE', content: hook.action.payload, messageId },
                connectionId,
              );
            }
          }
        })
        .catch((err) => {
          console.error('Failed to execute launch hooks:', err);
        });
    }

    // Message handler
    ws.on('message', async (data) => {
      try {
        const event = JSON.parse(data.toString()) as ClientEvent;
        await session.routeMessage(event, connectionId);
      } catch (err) {
        console.error('Failed to process message:', err);
      }
    });

    // Handle close - session persists for other connections!
    ws.on('close', () => {
      console.log(`WebSocket client disconnected: ${connectionId}`);
      session.removeConnection(connectionId);
      broadcastCenter.unsubscribe(connectionId);
      // Session stays alive for other connections
    });

    // Handle errors
    ws.on('error', (err) => {
      console.error('WebSocket error:', err);
    });
  });

  return wss;
}
