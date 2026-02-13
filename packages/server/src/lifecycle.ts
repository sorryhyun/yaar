/**
 * Server lifecycle — initialization, listening, shutdown.
 */

import type { Server } from 'http';
import type { WebSocketServer } from 'ws';
import { mkdir } from 'fs/promises';
import { join } from 'path';
import { ensureStorageDir } from './storage/index.js';
import { initMcpServer } from './mcp/server.js';
import { initWarmPool, getWarmPool } from './providers/factory.js';
import {
  listSessions,
  readSessionMessages,
  parseSessionMessages,
  getWindowRestoreActions,
  getContextRestoreMessages,
} from './logging/index.js';
import { PORT, PROJECT_ROOT, IS_BUNDLED_EXE } from './config.js';
import type { WebSocketServerOptions } from './websocket/index.js';
import { initSessionHub } from './session/live-session.js';

/**
 * Initialize all subsystems (storage, MCP, warm pool, session restore).
 * Returns the options to pass to createWebSocketServer.
 */
export async function initializeSubsystems(): Promise<WebSocketServerOptions> {
  await ensureStorageDir();

  // In bundled exe mode, auto-create runtime directories
  if (IS_BUNDLED_EXE) {
    await Promise.all([
      mkdir(join(PROJECT_ROOT, 'apps'), { recursive: true }),
      mkdir(join(PROJECT_ROOT, 'sandbox'), { recursive: true }),
      mkdir(join(PROJECT_ROOT, 'config'), { recursive: true }),
    ]);
  }

  // Initialize session hub (LiveSession instances created on first WS connection)
  initSessionHub();

  await initMcpServer();

  // Pre-warm provider pool for faster first connection
  const warmPoolReady = await initWarmPool();
  if (warmPoolReady) {
    const stats = getWarmPool().getStats();
    console.log(
      `Provider warm pool ready: ${stats.available} ${stats.preferredProvider} provider(s)`,
    );
  }

  // Restore window state from the most recent previous session
  const options: WebSocketServerOptions = {
    restoreActions: [],
    contextMessages: [],
  };

  try {
    const sessions = await listSessions();
    if (sessions.length > 0) {
      const lastSession = sessions[0];
      const messagesJsonl = await readSessionMessages(lastSession.sessionId);
      if (messagesJsonl) {
        const messages = parseSessionMessages(messagesJsonl);
        const restoreActions = getWindowRestoreActions(messages);
        if (restoreActions.length > 0) {
          options.restoreActions = restoreActions;
          console.log(
            `Restored ${restoreActions.length} window(s) from session ${lastSession.sessionId}`,
          );
        }
        const contextMessages = getContextRestoreMessages(messages);
        if (contextMessages.length > 0) {
          options.contextMessages = contextMessages;
          console.log(
            `Restored ${contextMessages.length} context message(s) from session ${lastSession.sessionId}`,
          );
        }
      }
      if (lastSession.metadata?.threadIds) {
        options.savedThreadIds = lastSession.metadata.threadIds;
        console.log(
          `Restored ${Object.keys(lastSession.metadata.threadIds).length} thread ID(s) from session ${lastSession.sessionId}`,
        );
      }
    }
  } catch (err) {
    console.error('Failed to restore previous session:', err);
  }

  return options;
}

export function startListening(server: Server): void {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`YAAR server running at http://127.0.0.1:${PORT}`);
    console.log('WebSocket endpoint: ws://127.0.0.1:' + PORT + '/ws');
    console.log('MCP endpoints: http://127.0.0.1:' + PORT + '/mcp/{system,window,storage,apps}');
  });
}

export async function shutdown(server: Server, wss: WebSocketServer): Promise<void> {
  console.log('\nShutting down...');

  await getWarmPool().cleanup();

  wss.close(() => {
    server.close(() => {
      process.exit(0);
    });
  });
  // Force exit after 2 seconds if graceful shutdown hangs
  setTimeout(() => process.exit(0), 2000);
}
