/**
 * SSH reverse tunnel using ssh2.
 *
 * Two modes:
 * 1. **Service mode** (`localhost.run`) — zero-config, auto-discovers SSH key,
 *    parses public URL from the service's shell output.
 * 2. **Custom server** — user provides host, username, auth in config.
 */

import { readFileSync } from 'fs';
import net from 'net';
import type { TunnelConfig } from './types.js';
import { findSshKey } from './config.js';

const TAG = '[Tunnel]';
const KEEPALIVE_INTERVAL = 15_000;
const KEEPALIVE_MAX_MISSED = 3;
const RECONNECT_MAX_DELAY = 30_000;
const SHUTDOWN_TIMEOUT = 3_000;
const SERVICE_URL_TIMEOUT = 15_000;

export class SshTunnel {
  private client: import('ssh2').Client | null = null;
  private localPort: number;
  private config: TunnelConfig;
  private connected = false;
  private shuttingDown = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private hasEverConnected = false;
  /** URL parsed from a managed service (e.g. localhost.run) */
  private serviceUrl: string | null = null;

  constructor(config: TunnelConfig, localPort: number) {
    this.config = config;
    this.localPort = localPort;
  }

  private get isService(): boolean {
    return this.config.service === 'localhost.run';
  }

  /**
   * Attempt to connect and establish the reverse tunnel.
   * Returns true if successful, false if connection failed.
   */
  async connect(): Promise<boolean> {
    if (this.isService) {
      return this.connectService();
    }
    return this.connectCustom();
  }

  /** Connect to a managed tunnel service (localhost.run). */
  private async connectService(): Promise<boolean> {
    const { Client } = await import('ssh2');
    this.client = new Client();
    this.serviceUrl = null;

    return new Promise<boolean>((resolve) => {
      const client = this.client!;
      let resolved = false;

      const fail = (msg: string) => {
        if (!resolved) {
          resolved = true;
          console.warn(`${TAG} ${msg}`);
          resolve(false);
        }
      };

      // Timeout for the entire connection + URL parsing
      const timeout = setTimeout(() => {
        fail('Timed out waiting for tunnel service URL');
        client.end();
      }, SERVICE_URL_TIMEOUT);

      client.on('ready', () => {
        // Request reverse port forwarding (localhost.run expects port 80)
        client.forwardIn('localhost', 80, (err) => {
          if (err) {
            clearTimeout(timeout);
            fail(`Failed to forward port: ${err.message}`);
            client.end();
            return;
          }
          this.connected = true;
          this.hasEverConnected = true;
          this.reconnectDelay = 1000;
        });

        // Open a shell — localhost.run prints the public URL here
        client.shell((err, stream) => {
          if (err) {
            clearTimeout(timeout);
            fail(`Failed to open shell: ${err.message}`);
            return;
          }
          stream.on('data', (data: Buffer) => {
            const text = data.toString();
            // localhost.run prints URLs like https://HASH.lhr.life
            const match = text.match(/https?:\/\/\S+\.lhr\.life/);
            if (match && !this.serviceUrl) {
              // eslint-disable-next-line no-control-regex
              this.serviceUrl = match[0].replace(/\x1b\[[0-9;]*m/g, '').trim();
              clearTimeout(timeout);
              console.log(`${TAG} Tunnel: ${this.serviceUrl}`);
              if (!resolved) {
                resolved = true;
                resolve(true);
              }
            }
          });
          stream.on('close', () => {
            // Shell closed — if we never got a URL, that's a failure
            if (!resolved) {
              clearTimeout(timeout);
              fail('Shell closed before URL was received');
            }
          });
        });
      });

      this.setupTcpForwarding(client);
      this.setupCloseHandlers(client, fail);

      // Auth: SSH agent → local key → fail
      const connectConfig: import('ssh2').ConnectConfig = {
        host: 'localhost.run',
        port: 22,
        username: 'nokey',
        keepaliveInterval: KEEPALIVE_INTERVAL,
        keepaliveCountMax: KEEPALIVE_MAX_MISSED,
        readyTimeout: 10_000,
      };

      if (process.env.SSH_AUTH_SOCK) {
        connectConfig.agent = process.env.SSH_AUTH_SOCK;
      } else {
        const key = findSshKey();
        if (key) {
          connectConfig.privateKey = key;
        } else {
          clearTimeout(timeout);
          fail('No SSH key found (~/.ssh/id_ed25519, id_rsa, or id_ecdsa) and no SSH_AUTH_SOCK');
          return;
        }
      }

      client.connect(connectConfig);
    });
  }

  /** Connect to a custom SSH server. */
  private async connectCustom(): Promise<boolean> {
    const { Client } = await import('ssh2');
    this.client = new Client();

    const remotePort = this.config.remotePort ?? this.localPort;
    const remoteHost = this.config.remoteHost ?? '0.0.0.0';

    return new Promise<boolean>((resolve) => {
      const client = this.client!;
      let resolved = false;

      const fail = (msg: string) => {
        if (!resolved) {
          resolved = true;
          console.warn(`${TAG} ${msg}`);
          resolve(false);
        }
      };

      client.on('ready', () => {
        client.forwardIn(remoteHost, remotePort, (err) => {
          if (err) {
            fail(`Failed to forward port: ${err.message}`);
            client.end();
            return;
          }
          this.connected = true;
          this.hasEverConnected = true;
          this.reconnectDelay = 1000;
          console.log(
            `${TAG} Reverse tunnel established: ${this.config.host}:${remotePort} → localhost:${this.localPort}`,
          );
          if (!resolved) {
            resolved = true;
            resolve(true);
          }
        });
      });

      this.setupTcpForwarding(client);
      this.setupCloseHandlers(client, fail);

      // Build auth config
      const connectConfig: import('ssh2').ConnectConfig = {
        host: this.config.host,
        port: this.config.port ?? 22,
        username: this.config.username,
        keepaliveInterval: KEEPALIVE_INTERVAL,
        keepaliveCountMax: KEEPALIVE_MAX_MISSED,
        readyTimeout: 10_000,
      };

      // Auth priority: privateKeyPath → password → SSH_AUTH_SOCK agent
      if (this.config.privateKeyPath) {
        try {
          connectConfig.privateKey = readFileSync(this.config.privateKeyPath);
        } catch (err) {
          fail(
            `Cannot read private key at ${this.config.privateKeyPath}: ${(err as Error).message}`,
          );
          return;
        }
      } else if (this.config.password) {
        connectConfig.password = this.config.password;
      } else if (process.env.SSH_AUTH_SOCK) {
        connectConfig.agent = process.env.SSH_AUTH_SOCK;
      } else {
        fail('No auth method available (privateKeyPath, password, or SSH_AUTH_SOCK)');
        return;
      }

      client.connect(connectConfig);
    });
  }

  /** Pipe incoming reverse-forwarded TCP connections to the local server. */
  private setupTcpForwarding(client: import('ssh2').Client): void {
    client.on('tcp connection', (_info, accept) => {
      const remote = accept();
      const local = net.createConnection({ port: this.localPort, host: '127.0.0.1' });
      remote.pipe(local);
      local.pipe(remote);
      remote.on('error', () => local.destroy());
      local.on('error', () => remote.destroy());
    });
  }

  /** Set up error/close handlers with auto-reconnect. */
  private setupCloseHandlers(client: import('ssh2').Client, fail: (msg: string) => void): void {
    client.on('error', (err) => {
      fail(`SSH connection error: ${err.message}`);
    });

    client.on('close', () => {
      const wasConnected = this.connected;
      this.connected = false;
      if (this.shuttingDown) {
        console.log(`${TAG} SSH tunnel closed`);
        return;
      }
      if (wasConnected || this.hasEverConnected) {
        console.warn(`${TAG} SSH connection dropped, reconnecting in ${this.reconnectDelay}ms...`);
        this.scheduleReconnect();
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.shuttingDown) return;
      const ok = await this.connect();
      if (!ok && !this.shuttingDown) {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_DELAY);
        this.scheduleReconnect();
      }
    }, this.reconnectDelay);
  }

  /** Whether the tunnel is currently connected. */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Construct the public URL for the tunnel.
   * @param token Remote auth token to embed in the URL hash.
   */
  getPublicUrl(token: string): string {
    // Service mode — use the URL parsed from the service output
    if (this.serviceUrl) {
      return `${this.serviceUrl}/#remote=${token}`;
    }

    // Custom server — construct from config
    const proto = this.config.publicHttps ? 'https' : 'http';
    const host = this.config.publicHost ?? this.config.host;
    const port = this.config.remotePort ?? this.localPort;
    const portSuffix =
      (proto === 'http' && port === 80) || (proto === 'https' && port === 443) ? '' : `:${port}`;
    return `${proto}://${host}${portSuffix}/#remote=${token}`;
  }

  /** Gracefully shut down the tunnel. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (!this.client) return;

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.client?.destroy();
        resolve();
      }, SHUTDOWN_TIMEOUT);

      this.client!.once('close', () => {
        clearTimeout(timeout);
        resolve();
      });
      this.client!.end();
    });
  }
}
