/**
 * Server lifecycle — initialization, banner, shutdown.
 */

import type { Server } from 'bun';
import { mkdir, stat as fsStat } from 'fs/promises';
import { readFileSync } from 'fs';
import { join } from 'path';
import { networkInterfaces } from 'os';
import { ensureStorageDir, loadMounts } from './storage/index.js';
import { initMcpServer } from './mcp/server.js';
import { listApps } from './features/apps/discovery.js';
import { syncAppShortcuts } from './storage/shortcuts.js';
import { initWarmPool, getWarmPool } from './providers/factory.js';
import {
  listSessions,
  readSessionMessages,
  parseSessionMessages,
  getWindowRestoreActions,
  getContextRestoreMessages,
  getCliRestoreEntries,
  createSession,
  SessionLogger,
} from './logging/index.js';
import {
  PROJECT_ROOT,
  IS_BUNDLED_EXE,
  IS_REMOTE,
  IS_DEV,
  getPort,
  isAppOriginIsolationRequested,
} from './config.js';
import { installProxyPortBoundary } from './http/origin-boundary.js';
import { initCompiler } from '@yaar/compiler';
import type { WebSocketServerOptions } from './websocket/index.js';
import { initSessionHub } from './session/session-hub.js';
import { setAccessRoleResolver } from './handlers/uri-registry.js';
import { getAgentRole } from './agents/agent-context.js';
import { generateRemoteToken, getRemoteToken } from './http/auth.js';
import {
  loadTunnelConfig,
  createTunnel,
  DEFAULT_TUNNEL,
  type TunnelConfig,
  type TunnelProvider,
} from './lib/tunnel/index.js';

let activeTunnel: TunnelProvider | null = null;

/**
 * The tunnel we intend to bring up, resolved in `initializeSubsystems` and connected
 * later in {@link startTunnel} — null when remote mode is off or the tunnel is disabled.
 *
 * Resolving the config and connecting are separate steps because the sockets sit between
 * them: the bind address depends on which transport was *chosen* (below), and a Tailscale
 * serve rule can only be pointed at a socket that is already listening.
 */
let plannedTunnel: TunnelConfig | null = null;

/**
 * Initialize all subsystems (storage, MCP, warm pool, session restore).
 * Returns the options to pass to createWsHandlers.
 */
export async function initializeSubsystems(): Promise<WebSocketServerOptions> {
  // Don't let stray async rejections (e.g. from the browser/CDP layer) take
  // down the whole server. Log and continue.
  process.on('unhandledRejection', (reason) => {
    console.warn('[unhandledRejection]', reason);
  });

  initCompiler({ projectRoot: PROJECT_ROOT, isBundledExe: IS_BUNDLED_EXE });

  // Wire central URI access control: session-principal handlers are reachable
  // only by the session agent.
  // Wired here (a non-cyclic boot module) rather than in handlers/index — a
  // named import of agent-context's getters from inside the handlers/agents
  // import cycle mis-links under Bun's module loader.
  setAccessRoleResolver(getAgentRole);

  await ensureStorageDir();

  // Warm mount cache and validate mount paths still exist
  const mounts = await loadMounts();
  if (mounts.length > 0) {
    for (const m of mounts) {
      try {
        await fsStat(m.hostPath);
      } catch {
        console.warn(`Mount "${m.alias}" → ${m.hostPath} — host path not found`);
      }
    }
    console.log(`Loaded ${mounts.length} mount(s)`);
  }

  // In bundled exe mode, auto-create runtime directories
  if (IS_BUNDLED_EXE) {
    await Promise.all([
      mkdir(join(PROJECT_ROOT, 'apps'), { recursive: true }),
      mkdir(join(PROJECT_ROOT, 'config'), { recursive: true }),
    ]);
  }

  // Generate auth token for remote mode, and decide which tunnel we're bringing up
  // (Tailscale Serve unless config/tunnel.json disables it). The connect itself
  // happens in startTunnel(), after the sockets exist.
  if (IS_REMOTE) {
    generateRemoteToken();
    const tunnelConfig = loadTunnelConfig();
    if (tunnelConfig?.disabled !== true) {
      plannedTunnel = tunnelConfig ?? DEFAULT_TUNNEL;
    }
  }

  // Dev mode: build frontend and start file watcher with live reload
  if (IS_DEV) {
    const { initDevBundler } = await import('./http/dev-bundler.js');
    await initDevBundler();
  }

  // Initialize session hub (LiveSession instances created on first WS connection)
  initSessionHub();

  await initMcpServer();

  // NOTE: App auto-compile + shortcut sync are deferred to
  // compileAppsAndSyncShortcuts(), and warm-pool init to initWarmProviders() —
  // both run AFTER Bun.serve() (see main.ts). Warm pool must, because codex
  // app-server connects to MCP at http://127.0.0.1:{PORT}/mcp/* and needs the
  // HTTP server listening. Compile is deferred so it no longer blocks the server
  // from accepting connections and can overlap the (slower) warm-pool spin-up;
  // the already-built dist/ is served in the meantime, and a fresh build
  // invalidates the app-list cache the moment it lands.

  // Create session log eagerly so user interactions are logged from the start
  const sessionInfo = await createSession('pending');
  const sessionLogger = new SessionLogger(sessionInfo);

  // Restore window state from the most recent previous session
  const options: WebSocketServerOptions = {
    restoreActions: [],
    contextMessages: [],
    sessionLogger,
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
        const cliEntries = getCliRestoreEntries(messages);
        if (cliEntries.length > 0) {
          options.cliEntries = cliEntries;
          console.log(
            `Restored ${cliEntries.length} CLI entries from session ${lastSession.sessionId}`,
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

/**
 * The address the main HTTP socket binds to.
 *
 * `tailscaled` reaches YAAR at `127.0.0.1`, so under the tunnel a LAN bind adds
 * reachability nobody asked for: only the tailnet (via the daemon) and localhost
 * should get in. Remote mode with the tunnel *disabled* is the one case that still
 * opens `0.0.0.0` — there the LAN URL is the only way in, which is the point.
 *
 * Decided from the *chosen* transport, not from whether it connected: someone who
 * asked for tailnet-only should not silently get their whole LAN exposed on a bearer
 * token because `tailscaled` was down. A failed Tailscale tunnel falls back to
 * localhost-only, not LAN-only.
 */
export function getBindHostname(): string {
  if (!IS_REMOTE) return '127.0.0.1';
  if (plannedTunnel) return '127.0.0.1'; // Tailscale Serve — loopback is all the daemon needs
  return '0.0.0.0';
}

/**
 * Should a second, app-origin socket be opened?
 *
 * This is app-origin isolation over a remote transport: the boundary needs two browser
 * origins, and over a proxy the only unspoofable way to attribute a request to one of
 * them is *which local socket it arrived on* (`http/origin-boundary.ts`). So the second
 * public port gets its own listener rather than sharing the desktop's.
 *
 * Tailscale can publish that second origin (a stable MagicDNS name on another port);
 * a transport that can't would answer false here.
 */
export function wantsAppOriginSocket(): boolean {
  return IS_REMOTE && isAppOriginIsolationRequested() && plannedTunnel !== null;
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
    // Localhost-only, never LAN-only: the bind followed the transport we *chose*, and a
    // daemon that failed to come up is not consent to expose the LAN. `{ "disabled": true }`
    // in config/tunnel.json is how you ask for the LAN URL on purpose.
    console.warn(
      '[Tunnel] Could not establish tunnel — localhost-only (set { "disabled": true } in config/tunnel.json for the LAN URL)',
    );
    return;
  }
  activeTunnel = tunnel;

  const boundary = tunnel.originBoundary?.() ?? null;
  if (boundary) {
    installProxyPortBoundary(boundary.desktopOrigin, boundary.appOrigin);
  }
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
      console.log(
        `Auto-compiled ${compileResult.compiled.length} app(s): ${compileResult.compiled.join(', ')}`,
      );
    }
    for (const f of compileResult.failed) {
      console.warn(`Failed to compile ${f.appId}: ${f.errors.join('; ')}`);
    }
  } catch (err) {
    console.error('Auto-compile error:', err);
  }

  // Sync desktop shortcuts: create missing, remove stale
  try {
    const apps = await listApps();
    const removedIds = await syncAppShortcuts(apps);
    if (removedIds.length > 0) {
      console.log(`Cleaned up ${removedIds.length} stale shortcut(s)`);
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
  const warmPoolReady = await initWarmPool();
  if (warmPoolReady) {
    const stats = getWarmPool().getStats();
    console.log(
      `Provider warm pool ready: ${stats.available} ${stats.preferredProvider} provider(s)`,
    );
  }
}

function getLanIp(): string {
  // WSL2: the Linux network interfaces have a NAT'd 172.x IP that's unreachable
  // from other devices. Ask Windows for the real LAN IP via PowerShell.
  if (isWsl()) {
    try {
      const result = Bun.spawnSync(
        [
          'powershell.exe',
          '-NoProfile',
          '-c',
          "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '172.*' -and $_.IPAddress -notlike '169.*' -and $_.PrefixOrigin -ne 'WellKnown' } | Select-Object -ExpandProperty IPAddress -First 1",
        ],
        { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const out = result.stdout.toString().trim();
      if (out) return out;
    } catch {
      // PowerShell not available or timed out — fall through
    }
  }

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

function isWsl(): boolean {
  try {
    return readFileSync('/proc/version', 'utf-8').toLowerCase().includes('microsoft');
  } catch {
    return false;
  }
}

/**
 * The URL this server is directly reachable at, tunnel aside.
 *
 * Under a loopback-only transport that is *not* the LAN IP — nothing outside this
 * machine can reach the port, so printing a LAN URL (or putting one in the QR) would be
 * advertising an address that refuses to connect.
 */
function getDirectUrl(): string {
  const host = getBindHostname() === '127.0.0.1' ? '127.0.0.1' : getLanIp();
  return `http://${host}:${getPort()}`;
}

/**
 * Get remote connection info for display in the frontend UI.
 * Returns null if not in remote mode.
 */
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
    const loopbackOnly = getBindHostname() === '127.0.0.1';
    const tunnelUrl = activeTunnel?.isConnected() ? activeTunnel.getPublicUrl(token) : null;
    const connectUrl = tunnelUrl ?? `${serverUrl}/#remote=${token}`;

    console.log('');
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║              YAAR Remote Mode                   ║');
    console.log('╠══════════════════════════════════════════════════╣');
    console.log(`║  Server:  ${serverUrl}${loopbackOnly ? '  (loopback only — no LAN)' : ''}`);
    if (tunnelUrl) {
      console.log(`║  Tunnel:  ${tunnelUrl}`);
    }
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
    console.log(`YAAR server running at http://${hostname}:${port}`);
    console.log(`WebSocket endpoint: ws://${hostname}:${port}/ws`);
    console.log(`MCP endpoints: http://${hostname}:${port}/mcp/{system,window,storage,apps}`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function shutdown(server: Server<any>, ...alsoStop: Server<any>[]): Promise<void> {
  console.log('\nShutting down...');

  // Hard deadline: force-kill the process if graceful shutdown takes too long.
  // On Windows, process.exit() can hang when Bun has active server handles,
  // so we use taskkill to force-terminate the entire process tree.
  const forceKillTimer = setTimeout(() => {
    console.error('Graceful shutdown timed out — force-killing process.');
    forceKillProcess();
  }, 5_000);

  try {
    // Drop the Tailscale serve rules
    if (activeTunnel) {
      await activeTunnel.shutdown();
      activeTunnel = null;
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

    // Disconnect external MCP servers
    try {
      const { getMcpClientManager } = await import('./mcp/external/index.js');
      const manager = await getMcpClientManager();
      await manager.disconnectAll();
    } catch {
      // External MCP module not initialized — nothing to clean up
    }

    // Flush and close per-app SQLite databases
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
    console.error('Error during shutdown:', err);
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
