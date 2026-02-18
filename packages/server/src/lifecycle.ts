/**
 * Server lifecycle — initialization, listening, shutdown.
 */

import type { Server } from 'http';
import type { WebSocketServer } from 'ws';
import { mkdir } from 'fs/promises';
import { join } from 'path';
import { networkInterfaces } from 'os';
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
import { PORT, PROJECT_ROOT, IS_BUNDLED_EXE, IS_REMOTE } from './config.js';
import type { WebSocketServerOptions } from './websocket/index.js';
import { initSessionHub } from './session/live-session.js';
import { generateRemoteToken, getRemoteToken } from './http/auth.js';

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

  // Generate auth token for remote mode
  if (IS_REMOTE) {
    generateRemoteToken();
  }

  // Initialize session hub (LiveSession instances created on first WS connection)
  initSessionHub();

  await initMcpServer();

  // Pre-warm provider pool (availability check, no network calls)
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

function getLanIp(): string {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

export function startListening(server: Server): void {
  const host = IS_REMOTE ? '0.0.0.0' : '127.0.0.1';
  server.listen(PORT, host, async () => {
    if (IS_REMOTE) {
      const token = getRemoteToken();
      const lanIp = getLanIp();
      const serverUrl = `http://${lanIp}:${PORT}`;
      const connectUrl = `${serverUrl}/#remote=${token}`;

      console.log('');
      console.log('╔══════════════════════════════════════════════════╗');
      console.log('║              YAAR Remote Mode                   ║');
      console.log('╠══════════════════════════════════════════════════╣');
      console.log(`║  Server:  ${serverUrl}`);
      console.log(`║  Token:   ${token}`);
      console.log('╠══════════════════════════════════════════════════╣');
      console.log(`║  Connect: ${connectUrl}`);
      console.log('╚══════════════════════════════════════════════════╝');
      console.log('');

      // Print QR code if available
      try {
        const qrcode = (await import('qrcode-terminal')) as {
          default: {
            generate(text: string, opts: { small: boolean }, cb: (qr: string) => void): void;
          };
        };
        qrcode.default.generate(connectUrl, { small: true }, (qr: string) => {
          console.log('Scan to connect:');
          console.log(qr);
        });
      } catch {
        // qrcode-terminal not available, skip
      }
    } else {
      console.log(`YAAR server running at http://127.0.0.1:${PORT}`);
      console.log('WebSocket endpoint: ws://127.0.0.1:' + PORT + '/ws');
      console.log('MCP endpoints: http://127.0.0.1:' + PORT + '/mcp/{system,window,storage,apps}');
    }
  });
}

export async function shutdown(server: Server, wss: WebSocketServer): Promise<void> {
  console.log('\nShutting down...');

  // Close browser sessions
  try {
    const { getBrowserPool } = await import('./lib/browser/index.js');
    await getBrowserPool().shutdown();
  } catch {
    // Browser module not available — nothing to clean up
  }

  await getWarmPool().cleanup();

  wss.close(() => {
    server.close(() => {
      process.exit(0);
    });
  });
  // Force exit after 2 seconds if graceful shutdown hangs
  setTimeout(() => process.exit(0), 2000);
}
