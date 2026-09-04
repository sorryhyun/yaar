/**
 * Server lifecycle — initialization, banner, shutdown.
 */

import type { Server } from 'bun';
import { mkdir, stat as fsStat } from 'fs/promises';
import { join } from 'path';
import { ensureStorageDir, loadMounts } from './storage/index.js';
import { initMcpServer } from './mcp/server.js';
import { listApps } from './features/apps/discovery.js';
import { syncAppShortcuts } from './storage/shortcuts.js';
import { initWarmPool, getWarmPool } from './providers/factory.js';
import {
  findRestorableSession,
  getWindowRestoreActions,
  getContextRestoreMessages,
  getCliRestoreEntries,
  createSession,
  pruneEmptySessions,
  SessionLogger,
} from './logging/index.js';
import {
  PROJECT_ROOT,
  IS_BUNDLED_EXE,
  IS_REMOTE,
  IS_FREEDPI,
  IS_DEV,
  getPort,
  getConfigDir,
  isAppOriginIsolationRequested,
  shouldPruneEmptySessions,
  WORKSPACE_NAME,
} from './config.js';
import { installProxyPortBoundary, installLoopbackAliasBoundary } from './http/origin-boundary.js';
import { initCompiler } from '@yaar/compiler';
import type { WebSocketServerOptions } from './websocket/index.js';
import { initSessionHub, getSessionHub } from './session/session-hub.js';
import { startHookScheduler, stopHookScheduler } from './features/config/hook-scheduler.js';
import { setAccessPrincipalResolver } from './handlers/uri-registry.js';
import { setUndelegatedUriResolver, setWindowGrantResolver } from './http/access.js';
import { getAccessPrincipal, getLogContext } from './agents/agent-context.js';
import { createLogger, setLogContextResolver } from './observability/log.js';
import { generateRemoteToken, getRemoteToken } from './http/auth.js';
import {
  loadTunnelConfig,
  createTunnel,
  DEFAULT_TUNNEL,
  type TunnelConfig,
  type TunnelProvider,
} from './lib/tunnel/index.js';
import { createFreeDpiProxy, setActiveFreeDpi, type FreeDpiProxy } from './lib/freedpi/index.js';

const log = createLogger('lifecycle');
/** The banner points at "[Tunnel] warnings above", so the tunnel keeps its own name. */
const tunnelLog = createLogger('Tunnel');

let activeTunnel: TunnelProvider | null = null;

/**
 * The DPI bypass proxy, unless `YAAR_FREEDPI=0` or it failed to bind.
 *
 * Started here rather than alongside the tunnel, because both of its consumers can be
 * reached before the HTTP sockets exist — `LAUNCH_CHROME=1` may spawn a browser, and any
 * startup path may `safeFetch`. Publishing the URL late would leave those on the direct
 * route while the flag claimed otherwise.
 */
let activeFreeDpi: FreeDpiProxy | null = null;

/**
 * The tunnel we intend to bring up, resolved in `initializeSubsystems` and connected
 * later in {@link startTunnel} — null exactly when remote mode is off.
 *
 * Resolving the config and connecting are separate steps because the sockets sit between
 * them: the app-origin socket is opened only when a transport can publish a second origin,
 * and a Tailscale serve rule can only be pointed at a socket that is already listening.
 */
let plannedTunnel: TunnelConfig | null = null;

/**
 * Initialize all subsystems (storage, MCP, warm pool, session restore).
 * Returns the options to pass to createWsHandlers.
 */
export async function initializeSubsystems(): Promise<WebSocketServerOptions> {
  // First, so that everything below logs with its ids attached. Same injected-resolver
  // shape as the two access resolvers under it, for the same import-graph reason:
  // observability/log.ts imports nothing, and agent-context is a long way up from it.
  setLogContextResolver(getLogContext);

  // Don't let stray async rejections (e.g. from the browser/CDP layer) take
  // down the whole server. Log and continue.
  process.on('unhandledRejection', (reason) => {
    log.warn('unhandled rejection', { reason });
  });

  initCompiler({ projectRoot: PROJECT_ROOT, isBundledExe: IS_BUNDLED_EXE });

  // Wire central URI access control: session-principal handlers are reachable
  // only by the session agent and by bundled system apps (whose iframe token
  // carries the flag — see routes/verb.ts).
  // Wired here (a non-cyclic boot module) rather than in handlers/index — a
  // named import of agent-context's getters from inside the handlers/agents
  // import cycle mis-links under Bun's module loader.
  setAccessPrincipalResolver(getAccessPrincipal);

  // Same reason, same shape: an app iframe's permissions are its app.json list *plus*
  // whatever storage files an agent named to its window (features/window/delegated-grants.ts).
  // Those live on the session's WindowStateRegistry, which http/access.ts cannot import.
  setWindowGrantResolver(
    (sessionId, windowId, monitorId) =>
      getSessionHub().get(sessionId)?.windowState.getWindowGrants(windowId, monitorId) ?? [],
  );
  // Diagnostics for the other half of the same rule — which paths a caller named to this
  // window and could *not* delegate, so the gate's 403 can say which refusal it is.
  setUndelegatedUriResolver(
    (sessionId, windowId, uri, monitorId) =>
      getSessionHub().get(sessionId)?.windowState.wasUndelegated(uri, windowId, monitorId) ?? false,
  );

  await ensureStorageDir();

  const mounts = await loadMounts();
  if (mounts.length > 0) {
    for (const m of mounts) {
      try {
        await fsStat(m.hostPath);
      } catch {
        log.warn('mount host path not found', { alias: m.alias, hostPath: m.hostPath });
      }
    }
    log.info('loaded mounts', { count: mounts.length });
  }

  if (IS_BUNDLED_EXE) {
    await Promise.all([
      mkdir(join(PROJECT_ROOT, 'apps'), { recursive: true }),
      mkdir(getConfigDir(), { recursive: true }),
    ]);
  }

  // Generate auth token for remote mode, and resolve the tunnel we're bringing up.
  // Remote mode is Tailscale Serve or nothing — config/tunnel.json only tunes it, and
  // can no longer turn it off. The connect itself happens in startTunnel(), after the
  // sockets exist.
  if (IS_REMOTE) {
    generateRemoteToken();
    plannedTunnel = loadTunnelConfig() ?? DEFAULT_TUNNEL;
  }

  // Never fatal. A bypass that will not bind leaves every consumer on the direct path,
  // which is the same code path the flag being unset takes — degraded, not broken.
  if (IS_FREEDPI) {
    try {
      activeFreeDpi = createFreeDpiProxy();
      setActiveFreeDpi(activeFreeDpi);
    } catch (err) {
      log.warn('DPI bypass could not start — continuing without it', { err });
    }
  }

  if (IS_DEV) {
    const { initDevBundler } = await import('./http/dev-bundler.js');
    await initDevBundler();
  }

  // Initialize session hub (LiveSession instances created on first WS connection)
  initSessionHub();

  // The clock behind `schedule` hooks. Started before any session exists — it delivers
  // into whatever is connected when an occurrence comes due, and drops it when nothing is.
  startHookScheduler();

  await initMcpServer();

  // NOTE: App auto-compile + shortcut sync are deferred to
  // compileAppsAndSyncShortcuts(), and warm-pool init to initWarmProviders() —
  // both run AFTER Bun.serve() (see main.ts). Warm pool must, because codex
  // app-server connects to MCP at http://127.0.0.1:{PORT}/mcp/* and needs the
  // HTTP server listening. Compile is deferred so it no longer blocks the server
  // from accepting connections and can overlap the (slower) warm-pool spin-up;
  // the already-built dist/ is served in the meantime, and a fresh build
  // invalidates the app-list cache the moment it lands.

  // Sweep the logs of launches that recorded nothing before adding this launch's own
  // (see logging/prune.ts). Deliberately before createSession() — the new directory is
  // then never a candidate — and never fatal.
  if (shouldPruneEmptySessions()) {
    try {
      const pruned = await pruneEmptySessions();
      if (pruned.length > 0) {
        log.info('pruned empty session logs', { count: pruned.length });
      }
    } catch (err) {
      log.warn('failed to prune empty session logs', { err });
    }
  }

  // Restore window state from the most recent previous session. Resolved BEFORE this
  // launch mints its own log below — see findRestorableSession().
  const options: WebSocketServerOptions = {
    restoreActions: [],
    contextMessages: [],
  };

  try {
    const restorable = await findRestorableSession();
    if (restorable) {
      const { session: lastSession, messages } = restorable;
      const restoreActions = getWindowRestoreActions(messages);
      if (restoreActions.length > 0) {
        options.restoreActions = restoreActions;
        log.info('restored windows', { count: restoreActions.length, from: lastSession.sessionId });
      }
      const contextMessages = getContextRestoreMessages(messages);
      if (contextMessages.length > 0) {
        options.contextMessages = contextMessages;
        log.info('restored context messages', {
          count: contextMessages.length,
          from: lastSession.sessionId,
        });
      }
      const cliEntries = getCliRestoreEntries(messages);
      if (cliEntries.length > 0) {
        options.cliEntries = cliEntries;
        log.info('restored CLI entries', { count: cliEntries.length, from: lastSession.sessionId });
      }
      if (lastSession.metadata?.threadIds) {
        options.savedThreadIds = lastSession.metadata.threadIds;
        log.info('restored thread ids', {
          count: Object.keys(lastSession.metadata.threadIds).length,
          from: lastSession.sessionId,
        });
      }
    }
  } catch (err) {
    log.error('failed to restore previous session', { err });
  }

  // Create session log eagerly so user interactions are logged from the start
  const sessionInfo = await createSession('pending');
  options.sessionLogger = new SessionLogger(sessionInfo);

  return options;
}

/**
 * The address the main HTTP socket binds to: always loopback, in every mode.
 *
 * `tailscaled` reaches YAAR at `127.0.0.1`, so the tunnel needs nothing else. A failed
 * tunnel therefore leaves the server localhost-only — the daemon being down is not
 * consent to expose a wider surface on a bearer token.
 */
export function getBindHostname(): string {
  return '127.0.0.1';
}

/**
 * Should a second, app-origin socket be opened?
 *
 * This is app-origin isolation over a remote transport: the boundary needs two browser
 * origins, and over a proxy the only unspoofable way to attribute a request to one of
 * them is *which local socket it arrived on* (`http/origin-boundary.ts`). So the second
 * public port gets its own listener rather than sharing the desktop's.
 *
 * Local mode needs no second socket — there the two origins are two hostnames on the
 * same one (`localhost`/`127.0.0.1`).
 */
export function wantsAppOriginSocket(): boolean {
  return IS_REMOTE && isAppOriginIsolationRequested();
}

/**
 * Bring the planned tunnel up, now that the sockets are listening.
 *
 * `appLocalPort` is the app-origin socket's port, or null if there isn't one. When the
 * transport confirms it published both origins, the proxy-port origin boundary is
 * installed and isolated apps start rendering cross-origin over the network.
 *
 * Never fatal: a tunnel that won't come up leaves the server reachable at whatever the
 * bind address allows, exactly as before.
 */
export async function startTunnel(appLocalPort: number | null): Promise<void> {
  if (!plannedTunnel) return;

  const tunnel = createTunnel(plannedTunnel, getPort(), appLocalPort);
  if (!(await tunnel.connect())) {
    tunnelLog.warn(
      'could not establish tunnel — localhost-only. Check `tailscale status` and that ' +
        'MagicDNS + HTTPS Certificates are enabled.',
    );
    // Nothing outside this machine can reach the server now, which is precisely where the
    // `localhost`/`127.0.0.1` split *does* work — so the degraded path keeps a boundary
    // instead of running with none. Without this, `isAppOriginIsolationEnabled()` answers
    // false under IS_REMOTE and an installed app would be same-origin with the desktop.
    if (isAppOriginIsolationRequested()) installLoopbackAliasBoundary();
    return;
  }
  activeTunnel = tunnel;

  const boundary = tunnel.originBoundary?.() ?? null;
  if (boundary) {
    installProxyPortBoundary(boundary.desktopOrigin, boundary.appOrigin);
  }
  // No boundary means the desktop rule came up but the app-origin one didn't (the tunnel
  // warns, naming the port). Deliberately *not* falling back to the loopback alias: a
  // browser on the MagicDNS name resolves no `127.0.0.1` of ours, so that boundary would
  // be one the server enforces and the browser never joins.
}

/**
 * Compile any stale apps, then reconcile desktop shortcuts against the result.
 *
 * Runs AFTER the HTTP server is listening (see main.ts) so a slow rebuild — e.g.
 * after a compiler-version bump makes every app stale — doesn't hold the server
 * offline. It runs concurrently with warm-pool init; the two are independent.
 * Compile-before-shortcut ordering is preserved so shortcuts see fresh builds.
 */
export async function compileAppsAndSyncShortcuts(): Promise<void> {
  try {
    const { autoCompileApps } = await import('./features/apps/auto-compile.js');
    const compileResult = await autoCompileApps();
    if (compileResult.compiled.length > 0) {
      log.info('auto-compiled apps', {
        count: compileResult.compiled.length,
        apps: compileResult.compiled.join(', '),
      });
    }
    for (const f of compileResult.failed) {
      log.warn('failed to compile app', { appId: f.appId, errors: f.errors.join('; ') });
    }
  } catch (err) {
    log.error('auto-compile error', { err });
  }

  // Sync desktop shortcuts: create missing, remove stale
  try {
    const apps = await listApps();
    const removedIds = await syncAppShortcuts(apps);
    if (removedIds.length > 0) {
      log.info('cleaned up stale shortcuts', { count: removedIds.length });
    }
  } catch {
    // Non-fatal: shortcuts will be created on next app interaction
  }
}

/**
 * Initialize the warm provider pool. Must be called AFTER the HTTP server
 * is listening so that codex app-server can reach the MCP endpoints.
 */
export async function initWarmProviders(): Promise<void> {
  let warmPoolReady: boolean;
  try {
    warmPoolReady = await initWarmPool();
  } catch (err) {
    const { CodexVersionError } = await import('./providers/codex/version.js');
    if (!(err instanceof CodexVersionError)) throw err;
    // The user named a provider YAAR cannot drive. Booting on regardless would either hand
    // them a different provider than they asked for or leave a desktop that answers nothing,
    // and either way the reason scrolls past in a stack trace. Refuse, in one sentence.
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }
  if (warmPoolReady) {
    const stats = getWarmPool().getStats();
    log.info('provider warm pool ready', {
      available: stats.available,
      provider: stats.preferredProvider,
    });
  }
}

/**
 * The URL this server is directly reachable at, tunnel aside.
 *
 * Always the loopback address, because {@link getBindHostname} is: nothing outside this
 * machine can reach the port, so any other address would refuse to connect.
 */
function getDirectUrl(): string {
  return `http://127.0.0.1:${getPort()}`;
}

export function getRemoteInfo(): {
  connectUrl: string;
  token: string;
  lanUrl: string;
  tunnelUrl: string | null;
} | null {
  if (!IS_REMOTE) return null;
  const token = getRemoteToken();
  if (!token) return null;
  const lanUrl = getDirectUrl();
  const tunnelUrl = activeTunnel?.isConnected() ? activeTunnel.getPublicUrl(token) : null;
  const connectUrl = tunnelUrl ?? `${lanUrl}/#remote=${token}`;
  return { connectUrl, token, lanUrl, tunnelUrl };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function printBanner(server: Server<any>): Promise<void> {
  const port = server.port;
  const hostname = server.hostname;

  if (IS_REMOTE) {
    const token = getRemoteToken()!;
    const serverUrl = getDirectUrl();
    const tunnelUrl = activeTunnel?.isConnected() ? activeTunnel.getPublicUrl(token) : null;
    const connectUrl = tunnelUrl ?? `${serverUrl}/#remote=${token}`;

    console.log('');
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║              YAAR Remote Mode                   ║');
    console.log('╠══════════════════════════════════════════════════╣');
    console.log(`║  Server:  ${serverUrl}  (loopback only)`);
    if (tunnelUrl) {
      console.log(`║  Tunnel:  ${tunnelUrl}`);
    } else {
      // No tunnel means nothing off this machine can connect at all — say so where the
      // connect URL is, rather than leaving a loopback URL looking like a remote one.
      console.log('║  Tunnel:  none — this machine only (see [Tunnel] warnings above)');
    }
    console.log(`║  Token:   ${token}`);
    console.log('╠══════════════════════════════════════════════════╣');
    console.log(`║  Connect: ${connectUrl}`);
    console.log('╚══════════════════════════════════════════════════╝');
    console.log('');

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
    console.log(`YAAR server running at http://${hostname}:${port}`);
    console.log(`WebSocket endpoint: ws://${hostname}:${port}/ws`);
    console.log(`MCP endpoints: http://${hostname}:${port}/mcp/{system,window,storage,apps}`);
  }
  if (WORKSPACE_NAME) {
    console.log(`Workspace: ${WORKSPACE_NAME} (state under workspaces/${WORKSPACE_NAME}/)`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function shutdown(server: Server<any>, ...alsoStop: Server<any>[]): Promise<void> {
  console.log('\nShutting down...');

  // Hard deadline: force-kill the process if graceful shutdown takes too long.
  // On Windows, process.exit() can hang when Bun has active server handles,
  // so we use taskkill to force-terminate the entire process tree.
  const forceKillTimer = setTimeout(() => {
    log.error('graceful shutdown timed out — force-killing process');
    forceKillProcess();
  }, 5_000);

  try {
    // Before the sessions go: a tick that starts mid-drain would deliver into a session
    // that is already tearing down.
    stopHookScheduler();

    // First, while the deadline above still has room: every live session, so each
    // `SessionLogger` flushes its debounced write buffer. Nothing else here rescues
    // it, and the buffer is the only shutdown casualty that cannot be recreated.
    await getSessionHub().drain();

    // Drop the Tailscale serve rules
    if (activeTunnel) {
      await activeTunnel.shutdown();
      activeTunnel = null;
    }

    // Retract the URL before stopping, so nothing routes at a listener that is going away.
    if (activeFreeDpi) {
      setActiveFreeDpi(null);
      activeFreeDpi.stop();
      activeFreeDpi = null;
    }

    // Release the clipboard grant's CDP connection. Independent of the two browser
    // providers below — it holds its own connection, and dropping theirs does not
    // touch the override (see lib/browser/clipboard-grant.ts).
    try {
      const { stopClipboardGrant } = await import('./lib/browser/clipboard-grant.js');
      stopClipboardGrant();
    } catch {
      // Never started — nothing to release.
    }

    // Close browser sessions — both doors (headless sandbox + the user's real
    // Chrome). The local provider never owns Chrome, so its shutdown only drops
    // our CDP connection.
    try {
      const { getHeadlessBrowser, getLocalBrowser } = await import('./lib/browser/index.js');
      await getHeadlessBrowser().shutdown();
      await getLocalBrowser().shutdown();
    } catch {
      // Browser module not available — nothing to clean up
    }

    try {
      const { getMcpClientManager } = await import('./mcp/external/index.js');
      const manager = await getMcpClientManager();
      await manager.disconnectAll();
    } catch {
      // External MCP module not initialized — nothing to clean up
    }

    try {
      const { closeAllAppDatabases } = await import('./db/index.js');
      closeAllAppDatabases();
    } catch {
      // db module never loaded — nothing to clean up
    }

    await getWarmPool().cleanup();

    server.stop();
    for (const extra of alsoStop) extra.stop();
  } catch (err) {
    log.error('error during shutdown', { err });
  }

  clearTimeout(forceKillTimer);
  forceKillProcess();
}

/**
 * Force-terminate the process. On Windows, uses taskkill to kill the entire
 * process tree since process.exit() can hang with active Bun server handles.
 */
function forceKillProcess(): void {
  if (process.platform === 'win32') {
    // On Windows, process.exit() can hang when Bun has active server handles.
    // Use taskkill /F /T to force-kill the entire process tree (including this
    // process and any child processes like conhost). Do NOT call process.exit()
    // afterward — it races with taskkill and can leave the process half-alive.
    try {
      const proc = Bun.spawn(['taskkill', '/F', '/T', '/PID', String(process.pid)], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      // Keep the event loop alive until taskkill terminates us.
      // If taskkill somehow fails, fall back to process.exit after a timeout.
      proc.exited
        .then(() => {
          // taskkill killed everything but we're somehow still here
          process.exit(0);
        })
        .catch(() => {
          process.exit(0);
        });
      // Safety net: if still alive after 3s, force exit
      setTimeout(() => process.exit(0), 3_000).unref?.();
      return;
    } catch {
      /* taskkill spawn failed — fall through to process.exit */
    }
  } else {
    // Kill entire process group so child processes (headless Chrome, etc.)
    // don't survive as orphans.
    try {
      process.kill(-process.pid, 'SIGKILL');
    } catch {
      /* ignore — process group may not exist */
    }
  }
  process.exit(0);
}
