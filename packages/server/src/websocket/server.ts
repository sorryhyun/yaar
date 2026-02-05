/**
 * WebSocket server factory with explicit options param.
 */

import type { Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { SessionManager } from '../agents/index.js';
import { windowStateRegistryManager } from '../mcp/window-state.js';
import { getWarmPool } from '../providers/factory.js';
import { getBroadcastCenter, generateConnectionId } from '../events/broadcast-center.js';
import type { ClientEvent, ServerEvent, OSAction } from '@yaar/shared';
import type { ContextMessage } from '../agents/context.js';

export interface WebSocketServerOptions {
  restoreActions: OSAction[];
  contextMessages: ContextMessage[];
}

export function createWebSocketServer(
  httpServer: Server,
  options: WebSocketServerOptions,
): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', async (ws: WebSocket) => {
    const connectionId = generateConnectionId();
    const broadcastCenter = getBroadcastCenter();

    console.log(`WebSocket client connected: ${connectionId}`);

    // Register connection with broadcast center
    broadcastCenter.subscribe(connectionId, ws);

    const manager = new SessionManager(connectionId, options.contextMessages);

    const windowState = windowStateRegistryManager.get(connectionId);
    if (options.restoreActions.length > 0) {
      windowState.restoreFromActions(options.restoreActions);
    }


    // Track initialization state and queue early messages
    let initialized = false;
    const earlyMessageQueue: ClientEvent[] = [];

    // Register message handler IMMEDIATELY to capture any early messages
    ws.on('message', async (data) => {
      try {
        const event = JSON.parse(data.toString()) as ClientEvent;

        if (!initialized) {
          console.log('Queuing early message:', event.type);
          earlyMessageQueue.push(event);
          return;
        }

        await manager.routeMessage(event);
      } catch (err) {
        console.error('Failed to process message:', err);
      }
    });

    // Handle close
    ws.on('close', async () => {
      console.log(`WebSocket client disconnected: ${connectionId}`);
      await manager.cleanup();
      broadcastCenter.unsubscribe(connectionId);
    });

    // Handle errors
    ws.on('error', (err) => {
      console.error('WebSocket error:', err);
    });

    // Mark as initialized immediately — pool initialization is lazy (on first message)
    initialized = true;

    await manager.initialize();

    // Send ready status
    const readyEvent: ServerEvent = {
      type: 'CONNECTION_STATUS',
      status: 'connected',
      provider: getWarmPool().getPreferredProvider() ?? 'claude',
    };
    ws.send(JSON.stringify(readyEvent));

    // Send restored window state from previous session
    if (options.restoreActions.length > 0) {
      const restoreEvent: ServerEvent = {
        type: 'ACTIONS',
        actions: options.restoreActions,
      };
      ws.send(JSON.stringify(restoreEvent));
    }

    if (earlyMessageQueue.length > 0) {
      console.log(`Processing ${earlyMessageQueue.length} queued message(s)`);
      for (const event of earlyMessageQueue) {
        try {
          await manager.routeMessage(event);
        } catch (err) {
          console.error('Failed to process queued message:', err);
        }
      }
    }
  });

  return wss;
}
