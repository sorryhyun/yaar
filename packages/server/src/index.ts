/**
 * YAAR TypeScript Backend Entry Point.
 *
 * Thin orchestrator: wires HTTP, WebSocket, and lifecycle together.
 */

import { createHttpServer } from './http/index.js';
import { createWebSocketServer } from './websocket/index.js';
import { initializeSubsystems, startListening, shutdown } from './lifecycle.js';

export { STORAGE_DIR } from './config.js';

// Create HTTP server
const server = createHttpServer();

// Initialize subsystems and start
async function startup() {
  const wsOptions = await initializeSubsystems();
  const wss = createWebSocketServer(server, wsOptions);

  startListening(server);

  // Graceful shutdown
  function handleShutdown() {
    shutdown(server, wss).catch((err) => {
      console.error('Shutdown error:', err);
      process.exit(1);
    });
  }

  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);
}

startup();
