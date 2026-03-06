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
import { listApps } from './mcp/apps/discovery.js';
import { syncAppShortcuts } from './storage/shortcuts.js';
import { initWarmPool, getWarmPool } from './providers/factory.js';
import {
  listSessions,
  readSessionMessages,
  parseSessionMessages,
  getWindowRestoreActions,
  getContextRestoreMessages,
} from './logging/index.js';
import { PROJECT_ROOT, IS_BUNDLED_EXE, IS_REMOTE, PORT } from './config.js';
import type { WebSocketServerOptions } from './websocket/index.js';
import { initSessionHub } from './session/session-hub.js';
import { generateRemoteToken, getRemoteToken } from './http/auth.js';
import { loadTunnelConfig, SshTunnel } from './lib/tunnel/index.js';

let activeTunnel: SshTunnel | null = null;

/**
 * Initialize all subsystems (storage, MCP, warm pool, session restore).
 * Returns the options to pass to createWsHandlers.
 */
export async function initializeSubsystems(): Promise<WebSocketServerOptions> {
  await ensureStorageDir();

  // Warm mount cache and validate mount paths still exist
  const mounts = await loadMounts();
  if (mounts.length > 0) {
    for (const m of mounts) {
      try {
        await fsStat(m.hostPath);
      } catch {
        console.warn(`Mount "${m.alias}" \u2192 ${m.hostPath} \u2014 host path not found`);
      }
    }
    console.log(`Loaded ${mounts.length} mount(s)`);
  }

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

    // Attempt SSH tunnel (defaults to localhost.run if no config)
    const tunnelConfig = loadTunnelConfig();
    if (tunnelConfig?.disabled !== true) {
      const config = tunnelConfig ?? { service: 'localhost.run' as const };
      const tunnel = new SshTunnel(config, PORT);
      const ok = await tunnel.connect();
      if (ok) {
        activeTunnel = tunnel;
      } else {
        console.warn('[Tunnel] Could not establish tunnel — LAN-only mode');
      }
    }
  }

  // Initialize session hub (LiveSession instances created on first WS connection)
  initSessionHub();

  await initMcpServer();

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function printBanner(server: Server<any>): Promise<void> {
  const port = server.port;
  const hostname = server.hostname;

  if (IS_REMOTE) {
    const token = getRemoteToken()!;
    const lanIp = getLanIp();
    const serverUrl = `http://${lanIp}:${port}`;
    const lanConnectUrl = `${serverUrl}/#remote=${token}`;
    const tunnelUrl = activeTunnel?.isConnected() ? activeTunnel.getPublicUrl(token) : null;
    const connectUrl = tunnelUrl ?? lanConnectUrl;

    console.log('');
    console.log(
      '\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557',
    );
    console.log('\u2551              YAAR Remote Mode                   \u2551');
    console.log(
      '\u2560\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2563',
    );
    console.log(`\u2551  Server:  ${serverUrl}`);
    if (tunnelUrl) {
      console.log(`\u2551  Tunnel:  ${tunnelUrl}`);
    }
    console.log(`\u2551  Token:   ${token}`);
    console.log(
      '\u2560\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2563',
    );
    console.log(`\u2551  Connect: ${connectUrl}`);
    console.log(
      '\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d',
    );
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
export async function shutdown(server: Server<any>): Promise<void> {
  console.log('\nShutting down...');

  // Close SSH tunnel
  if (activeTunnel) {
    await activeTunnel.shutdown();
    activeTunnel = null;
  }

  // Close browser sessions
  try {
    const { getBrowserPool } = await import('./lib/browser/index.js');
    await getBrowserPool().shutdown();
  } catch {
    // Browser module not available — nothing to clean up
  }

  await getWarmPool().cleanup();

  server.stop();
  process.exit(0);
}
