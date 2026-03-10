/**
 * YAAR TypeScript Backend Entry Point.
 *
 * Single Bun.serve() call unifying HTTP + WebSocket.
 */

import { createFetchHandler } from './http/index.js';
import { createWsHandlers, type WsData } from './websocket/index.js';
import { initializeSubsystems, initWarmProviders, shutdown, printBanner } from './lifecycle.js';
import { PORT, IS_REMOTE } from './config.js';

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

  // Initialize warm pool AFTER server is listening — codex app-server needs
  // to reach MCP endpoints at http://127.0.0.1:{PORT}/mcp/*
  await initWarmProviders();

  // Guard against re-entrant shutdown (e.g. SIGINT during uncaughtException handler)
  let shutdownInProgress = false;

  function handleShutdown() {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    shutdown(server).catch((err) => {
      console.error('Shutdown error:', err);
      process.exit(1);
    });
  }

  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);

  // Catch unhandled errors — ensure Chrome and other resources are cleaned up
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    handleShutdown();
  });
  process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err);
    handleShutdown();
  });
}

startup();
