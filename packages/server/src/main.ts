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
  getBindHostname,
  wantsAppOriginSocket,
  startTunnel,
} from './lifecycle.js';
import { IS_REMOTE, getPort, setPort, TRANSPORT_IDLE_TIMEOUT_S } from './config.js';

const MAX_PORT_ATTEMPTS = 20;

/** Bind a socket, walking upward from `preferredPort` past anything already in use. */
function serveFromFirstFreePort(
  preferredPort: number,
  hostname: string,
  fetch: ReturnType<typeof createFetchHandler>,
  websocket: ReturnType<typeof createWsHandlers>,
): { server: ReturnType<typeof Bun.serve<WsData>>; port: number } {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    const port = preferredPort + attempt;
    try {
      const server = Bun.serve<WsData>({
        port,
        hostname,
        // The outer bound on every server-side deadline (see MAX_REQUEST_DEADLINE_MS).
        // Bun's default of 10s is far too short for MCP tool calls and SSE streams.
        idleTimeout: TRANSPORT_IDLE_TIMEOUT_S,
        fetch,
        websocket,
      });
      return { server, port };
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
  throw new Error(
    `Could not find a free port in range ${preferredPort}–${preferredPort + MAX_PORT_ATTEMPTS - 1}: ${lastError}`,
  );
}

async function startup() {
  const wsOptions = await initializeSubsystems();
  const websocket = createWsHandlers(wsOptions);
  const hostname = getBindHostname();
  const preferredPort = getPort();

  const { server, port } = serveFromFirstFreePort(
    preferredPort,
    hostname,
    createFetchHandler(),
    websocket,
  );
  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} in use, using ${port} instead`);
    setPort(port);
  }

  // The app-origin socket (app-origin isolation over a remote transport). Always
  // loopback: the tunnel's second public port is what reaches it, and the *only* thing
  // this socket exists to prove is which origin the browser addressed — see
  // http/origin-boundary.ts. Its own port never appears in a URL, so it just takes the
  // first free one above the desktop's.
  const appOrigin = wantsAppOriginSocket()
    ? serveFromFirstFreePort(
        port + 1,
        '127.0.0.1',
        createFetchHandler({ appOriginSocket: true }),
        websocket,
      )
    : null;

  // Bring the tunnel up now that both sockets are listening — a serve rule can only
  // point at a port that is already accepting.
  await startTunnel(appOrigin?.port ?? null);

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
    shutdown(server, ...(appOrigin ? [appOrigin.server] : [])).catch((err) => {
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
