/**
 * YAAR TypeScript Backend Entry Point.
 *
 * Single Bun.serve() call unifying HTTP + WebSocket.
 */

import { createFetchHandler } from './http/index.js';
import { createWsHandlers, type WsData } from './websocket/index.js';
import { initializeSubsystems, initWarmProviders, shutdown, printBanner } from './lifecycle.js';
import { IS_REMOTE, getPort, setPort } from './config.js';

const MAX_PORT_ATTEMPTS = 20;

async function startup() {
  const wsOptions = await initializeSubsystems();
  const fetch = createFetchHandler();
  const websocket = createWsHandlers(wsOptions);
  const hostname = IS_REMOTE ? '0.0.0.0' : '127.0.0.1';
  const preferredPort = getPort();

  let server!: ReturnType<typeof Bun.serve<WsData>>;
  let lastError: unknown;
  let bound = false;

  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    const port = preferredPort + attempt;
    try {
      server = Bun.serve<WsData>({
        port,
        hostname,
        idleTimeout: 255, // seconds; default 10 is too short for MCP tool calls and SSE streams
        fetch,
        websocket,
      });
      if (port !== preferredPort) {
        console.log(`Port ${preferredPort} in use, using ${port} instead`);
        setPort(port);
      }
      bound = true;
      break;
    } catch (err) {
      lastError = err;
      if (
        err instanceof Error &&
        (err.message.includes('EADDRINUSE') || (err as NodeJS.ErrnoException).code === 'EADDRINUSE')
      ) {
        continue;
      }
      throw err; // non-port error, rethrow
    }
  }

  if (!bound) {
    throw new Error(
      `Could not find a free port in range ${preferredPort}–${preferredPort + MAX_PORT_ATTEMPTS - 1}: ${lastError}`,
    );
  }

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

/** Resolves when the server is fully ready (listening + warm pool initialized). */
export const ready = startup();
