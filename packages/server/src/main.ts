/**
 * YAAR TypeScript Backend Entry Point.
 *
 * Single Bun.serve() call unifying HTTP + WebSocket.
 */

import { createFetchHandler } from './http/index.js';
import { createWsHandlers, type WsData } from './websocket/index.js';
import {
  initializeSubsystems,
  initWarmProviders,
  compileAppsAndSyncShortcuts,
  shutdown,
  printBanner,
} from './lifecycle.js';
import { IS_REMOTE, getPort, setPort, TRANSPORT_IDLE_TIMEOUT_S } from './config.js';

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
        // The outer bound on every server-side deadline (see MAX_REQUEST_DEADLINE_MS).
        // Bun's default of 10s is far too short for MCP tool calls and SSE streams.
        idleTimeout: TRANSPORT_IDLE_TIMEOUT_S,
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

  // Compile stale apps and warm the provider pool concurrently, AFTER the server
  // is listening — codex app-server needs to reach MCP endpoints at
  // http://127.0.0.1:{PORT}/mcp/*, and compile no longer blocks either the
  // server or the (slower) warm-pool spin-up. Neither is fatal on failure.
  await Promise.all([
    compileAppsAndSyncShortcuts().catch((err) =>
      console.error('App compile/shortcut sync error:', err),
    ),
    initWarmProviders(),
  ]);

  // Re-print connect URL after warm pool so it's visible at the bottom
  if (IS_REMOTE) {
    const { getRemoteInfo } = await import('./lifecycle.js');
    const info = getRemoteInfo();
    if (info) console.log(`\nConnect: ${info.connectUrl}\n`);
  }

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

  // Benchmarking hook: `kill -USR2 <pid>` prints a one-line memory snapshot of
  // THIS server process (RSS + JS heap). Lets an external harness mark phase
  // boundaries (boot-idle, after-market, after-singularity) and diff the deltas.
  // Bun's --heap-prof only dumps once at exit; this gives per-phase samples.
  // Deliberately uses only process.memoryUsage() (cheap) and NOT bun:jsc
  // heapStats() — the latter is expensive enough to dominate the near-idle
  // server's own --cpu-prof flamegraph and skew the very benchmark it serves.
  process.on('SIGUSR2', () => {
    const m = process.memoryUsage();
    const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
    console.log(
      `[mem-snapshot] rss=${mb(m.rss)}MB heapUsed=${mb(m.heapUsed)}MB ` +
        `heapTotal=${mb(m.heapTotal)}MB external=${mb(m.external)}MB ` +
        `arrayBuffers=${mb(m.arrayBuffers)}MB`,
    );
  });

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
