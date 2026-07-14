/**
 * WebSocket handlers for Bun.serve() with LiveSession join protocol.
 *
 * Multiple WebSocket connections can join the same LiveSession.
 * New connections receive a snapshot of current window state.
 */

import type { ServerWebSocket } from 'bun';
import type { LiveSessionOptions } from '../session/live-session.js';
import { getSessionHub } from '../session/session-hub.js';
import { getWarmPool } from '../providers/factory.js';
import { getBroadcastCenter, generateConnectionId } from '../session/broadcast-center.js';
import {
  ServerEventType,
  type ClientEvent,
  type OSAction,
  type CliRestoreEntry,
} from '@yaar/shared';
import type { ContextMessage } from '../agents/context.js';
import type { SessionLogger } from '../logging/session-logger.js';
import { checkWsAuth } from '../http/auth.js';
import { handleBridgeOpen, handleBridgeMessage, handleBridgeClose } from './bridge-handlers.js';

export interface WebSocketServerOptions {
  restoreActions: OSAction[];
  contextMessages: ContextMessage[];
  savedThreadIds?: Record<string, string>;
  cliEntries?: CliRestoreEntry[];
  sessionLogger?: SessionLogger;
}

export interface WsData {
  /** Which WebSocket protocol this connection speaks. Defaults to 'frontend' (the /ws path). */
  kind: 'frontend' | 'bridge';
  connectionId: string;
  sessionId: string | null;
  monitorId: string | null;
}

export function createWsHandlers(options: WebSocketServerOptions) {
  return {
    async open(ws: ServerWebSocket<WsData>) {
      if (ws.data.kind === 'bridge') return handleBridgeOpen(ws);
      const { connectionId } = ws.data;
      const broadcastCenter = getBroadcastCenter();

      // Get or create session
      const hub = getSessionHub();
      const sessionOptions: LiveSessionOptions = {
        restoreActions: options.restoreActions,
        contextMessages: options.contextMessages,
        savedThreadIds: options.savedThreadIds,
        sessionLogger: options.sessionLogger,
      };
      const requestedSessionId = ws.data.sessionId;
      const { session, recoveryMode } = hub.attach(requestedSessionId, sessionOptions);
      hub.cancelEviction(session.sessionId);

      // Update ws.data with the actual session ID (may differ from requested)
      ws.data.sessionId = session.sessionId;

      // Register connection with session and broadcast center
      // Bun's ServerWebSocket has the same send/readyState API as our YaarWebSocket
      session.addConnection(connectionId, ws);
      broadcastCenter.subscribe(connectionId, ws, session.sessionId);

      // Auto-subscribe to monitor if specified in query params. A connection that names
      // no monitor receives no monitor-scoped events until it sends SUBSCRIBE_MONITOR —
      // the frontend does so on mount.
      const monitorId = ws.data.monitorId;
      if (monitorId) {
        broadcastCenter.subscribeToMonitor(connectionId, monitorId);
      }

      console.log(
        `WebSocket client connected: ${connectionId} → session ${session.sessionId} ` +
          `(epoch ${session.epoch}, ${recoveryMode})`,
      );

      // The attachment handshake. An open socket says only that transport exists; this is
      // what tells the client which session incarnation it is now bound to, and whether
      // that is the one it left. Sent before the snapshot, because the client needs the
      // session id in hand (iframe tokens are minted against it) before windows arrive.
      session.sendTo(connectionId, {
        type: ServerEventType.SESSION_ATTACHED,
        sessionId: session.sessionId,
        sessionEpoch: session.epoch,
        connectionId,
        recoveryMode,
        provider: getWarmPool().getPreferredProvider() ?? 'claude',
        // Absent until the pool initializes (first message); the client falls back then.
        logSessionId: session.getPool()?.getLogSessionId() ?? undefined,
      });

      // The session's monitors, before its windows — a window arrives on a monitor, and a
      // reconnecting tab that had never heard of that monitor could not render it.
      session.sendTo(connectionId, {
        type: ServerEventType.MONITORS,
        monitors: session.getMonitors(),
      });

      // Send snapshot of current windows to new connection
      const snapshotActions = await session.generateSnapshot();
      if (snapshotActions.length > 0) {
        session.sendTo(connectionId, { type: ServerEventType.ACTIONS, actions: snapshotActions });
      }

      // Send CLI history restore entries (only once, then clear)
      if (options.cliEntries && options.cliEntries.length > 0) {
        session.sendTo(connectionId, {
          type: ServerEventType.CLI_RESTORE,
          entries: options.cliEntries,
        });
        options.cliEntries = undefined;
      }

      // Execute launch hooks for fresh sessions (not reconnections)
      if (!requestedSessionId) {
        session.executeLaunchHooks(connectionId).catch((err) => {
          console.error('Failed to execute launch hooks:', err);
        });
      }
    },

    async message(ws: ServerWebSocket<WsData>, data: string | Buffer) {
      if (ws.data.kind === 'bridge') return handleBridgeMessage(ws, data);
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
      if (ws.data.kind === 'bridge') return handleBridgeClose(ws);
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
      data: { kind: 'frontend', connectionId: '', sessionId: null, monitorId: null },
    };
  }

  return {
    authorized: true,
    data: {
      kind: 'frontend',
      connectionId: generateConnectionId(),
      sessionId: url.searchParams.get('sessionId'),
      monitorId: url.searchParams.get('monitorId'),
    },
  };
}
