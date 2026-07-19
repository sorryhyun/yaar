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
  isAnswerEvent,
  isControlEvent,
  type ClientEvent,
  type OSAction,
  type CliRestoreEntry,
} from '@yaar/shared';
import type { AITransport } from '../providers/types.js';
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
  /**
   * Where this server's sessions get their AI providers. Defaults to the global warm pool.
   * Injected by the loopback test harness so a turn can be a script instead of a CLI —
   * see `tests/harness/scripted-provider.ts`.
   */
  acquireProvider?: () => Promise<AITransport | null>;
}

export interface WsData {
  /** Which WebSocket protocol this connection speaks. Defaults to 'frontend' (the /ws path). */
  kind: 'frontend' | 'bridge';
  connectionId: string;
  sessionId: string | null;
  monitorId: string | null;
  /**
   * Serializes this connection's messages against each other.
   *
   * `message()` is async, and Bun does not wait for one call to finish before making the
   * next — so two frames from the same socket ran concurrently and could land out of
   * order. That was survivable while every message was independent. It stops being
   * survivable with `RESYNC`, whose entire contract is *"you have now heard everything I
   * did while I was away"*: if the buffered `window.create` in front of it is still
   * awaiting `getAppMeta` when the snapshot is built, the snapshot omits that window and
   * the client — trusting it — deletes it. Order was always the intent; now it is enforced.
   */
  queue?: Promise<void>;
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
        acquireProvider: options.acquireProvider,
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

      // No snapshot is pushed here. The client asks for one (`RESYNC`) once it has flushed
      // what it was holding — the interactions it buffered while the socket was down, the
      // messages in its outbox — because only then is the server's state a complete answer.
      // Pushing it here, as this used to, meant racing the client's own flush and reporting
      // a window the user had just opened as one that does not exist.

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

    message(ws: ServerWebSocket<WsData>, data: string | Buffer) {
      if (ws.data.kind === 'bridge') return handleBridgeMessage(ws, data);

      let event: ClientEvent | undefined;
      try {
        event = JSON.parse(typeof data === 'string' ? data : data.toString()) as ClientEvent;
      } catch {
        // Leave it undefined; routeOne reports the parse failure back to the client.
      }

      // Two kinds of frame jump the queue, for two different reasons.
      //
      // An answer *must* overtake the frame in front of it, because that frame is what is
      // waiting for it (ANSWER_EVENT_TYPES in @yaar/shared).
      //
      // A control frame *may* overtake, because it has no ordering relationship with what
      // it passes and what it passes can be a whole streaming turn — a `USER_MESSAGE`
      // processed inline holds this queue until the model stops (CONTROL_EVENT_TYPES).
      if (event && (isAnswerEvent(event.type) || isControlEvent(event.type))) {
        return routeOne(ws, event);
      }

      // One at a time, in the order they arrived. See WsData.queue.
      ws.data.queue = (ws.data.queue ?? Promise.resolve()).then(() => routeOne(ws, event));
      return ws.data.queue;
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
 * Route one client frame, and make sure that whatever happens to it, the client hears.
 *
 * This is the outermost catch for the whole message path — a budget slot that never freed,
 * a monitor that could not be resolved, a pool mid-reset. Every one of those throws
 * carried a `messageId` up through the stack, and this frame used to `console.error` it
 * into the server's own logs and return, leaving the user watching a chip that said
 * "queued" for a message that had already died. The id is right here in the event; the
 * error now carries it back.
 */
async function routeOne(
  ws: ServerWebSocket<WsData>,
  event: ClientEvent | undefined,
): Promise<void> {
  const { connectionId, sessionId } = ws.data;
  if (!event) {
    sendError(ws, 'Failed to process message: not valid JSON');
    return;
  }
  try {
    const session = getSessionHub().get(sessionId!);
    if (!session) {
      // The session was evicted out from under this socket. Silence here read to the user
      // as a command that simply never happened.
      sendError(ws, 'Message dropped: this session is no longer live. Reload to reconnect.', event);
      return;
    }
    await session.routeMessage(event, connectionId);
  } catch (err) {
    console.error('Failed to process message:', err);
    sendError(ws, err instanceof Error ? err.message : 'Failed to process message', event);
  }
}

/** Report a failure back over the socket, naming the message it killed when there is one. */
function sendError(ws: ServerWebSocket<WsData>, error: string, event?: ClientEvent): void {
  const messageId = (event as { messageId?: string } | undefined)?.messageId;
  const monitorId = (event as { monitorId?: string } | undefined)?.monitorId;
  try {
    ws.send(
      JSON.stringify({
        type: ServerEventType.ERROR,
        error,
        ...(messageId ? { messageId } : {}),
        ...(monitorId ? { monitorId } : {}),
      }),
    );
  } catch {
    // The socket is gone too. Nothing left to tell.
  }
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
