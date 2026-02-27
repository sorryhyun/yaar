/**
 * YAAR TypeScript Backend Entry Point.
 *
 * Single Bun.serve() call unifying HTTP + WebSocket.
 */

import { createFetchHandler } from './http/index.js';
import { createWsHandlers, type WsData } from './websocket/index.js';
import { initializeSubsystems, shutdown, printBanner } from './lifecycle.js';
import { PORT, IS_REMOTE } from './config.js';

export { STORAGE_DIR } from './config.js';

async function startup() {
  const wsOptions = await initializeSubsystems();
  const fetch = createFetchHandler();
  const websocket = createWsHandlers(wsOptions);

  const server = Bun.serve<WsData>({
    port: PORT,
    hostname: IS_REMOTE ? '0.0.0.0' : '127.0.0.1',
    idleTimeout: 255, // seconds; default 10 is too short for MCP tool calls and SSE streams
    fetch,
    websocket,
  });

  await printBanner(server);

  // Graceful shutdown
  function handleShutdown() {
    shutdown(server).catch((err) => {
      console.error('Shutdown error:', err);
      process.exit(1);
    });
  }

  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);
}

startup();
