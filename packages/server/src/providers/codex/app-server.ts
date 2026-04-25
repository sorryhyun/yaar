/**
 * App-server process manager for Codex (WebSocket transport).
 *
 * Manages the lifecycle of a `codex app-server` child process:
 * - Spawns with `--listen ws://127.0.0.1:{port}` for WebSocket transport
 * - Maintains a control client for auth and account operations
 * - Exposes `createConnection()` so each CodexProvider gets its own WS connection
 * - Owned by WarmPool singleton (single owner, no refcounting)
 *
 * Each provider's WebSocket carries its own notifications/requests, so the
 * single-turn serialization mutex is no longer needed.
 */

import type { Subprocess } from 'bun';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { JsonRpcWsClient } from './jsonrpc-ws-client.js';
import { getMcpToken, CORE_SERVERS } from '../../mcp/index.js';
import {
  getCodexSpawnArgs,
  getCodexAppServerArgs,
  getCodexWsPort,
  STORAGE_DIR,
} from '../../config.js';
import { CODEX_AGENT_ROLES, codexRoleToToml } from '../../agents/profiles/index.js';
import type {
  InitializeParams,
  InitializeResponse,
  GetAccountParams,
  GetAccountResponse,
  LoginAccountParams,
  LoginAccountResponse,
  CancelLoginAccountParams,
  CancelLoginAccountResponse,
} from './types.js';

/**
 * Configuration for the app-server.
 */
export interface AppServerConfig {
  /** Model to use (default: gpt-5.5) */
  model?: string;
  /** Request timeout in milliseconds */
  requestTimeout?: number;
}

/**
 * Events emitted by the AppServer.
 */
export interface AppServerEvents {
  /** Emitted when a notification is received from the control client */
  notification: (method: string, params: unknown) => void;
  /** Emitted when the server process exits */
  exit: (code: number | null, signal: string | null) => void;
  /** Emitted when an error occurs */
  error: (error: Error) => void;
}

/**
 * Manages a codex app-server child process with WebSocket transport.
 *
 * @example
 * ```ts
 * const server = new AppServer();
 * await server.start();
 *
 * // Each provider gets its own connection
 * const conn = await server.createConnection();
 * const { threadId } = await conn.request('thread/start', { ... });
 * await conn.request('turn/start', { threadId, input: [...] });
 *
 * await server.stop();
 * ```
 */
export class AppServer {
  private process: Subprocess | null = null;
  private controlClient: JsonRpcWsClient | null = null;
  private tempDir: string | null = null;
  private readonly config: AppServerConfig;
  private readonly wsPort: number;

  // Capabilities received from initialize handshake
  private initializeResult: InitializeResponse | null = null;

  // Event listeners
  private notificationListeners: Array<(method: string, params: unknown) => void> = [];
  private exitListeners: Array<(code: number | null, signal: string | null) => void> = [];
  private errorListeners: Array<(error: Error) => void> = [];

  constructor(config: AppServerConfig = {}) {
    this.config = config;
    this.wsPort = getCodexWsPort();
  }

  /** Shared initialize params for all connections. */
  private get initializeParams(): InitializeParams {
    return {
      clientInfo: { name: 'yaar', title: 'YAAR Desktop', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    };
  }

  /**
   * Start the app-server process.
   */
  async start(): Promise<void> {
    if (this.process) {
      throw new Error('AppServer is already running');
    }

    // Create temp directory for agent role configs
    this.tempDir = await mkdtemp(join(tmpdir(), 'codex-'));

    // Write agent role config files so subagents inherit the correct model
    const agentsDir = join(this.tempDir, 'agents');
    await mkdir(agentsDir);
    for (const [role, config] of Object.entries(CODEX_AGENT_ROLES)) {
      await Bun.write(join(agentsDir, `${role}.toml`), codexRoleToToml(config, this.config.model));
    }

    await this.spawnProcess();

    // Connect the control client + initialize (retry loop until server is ready)
    await this.connectControlClient();
  }

  /**
   * Kill any stale process occupying the WebSocket port.
   * This handles the case where a previous YAAR server crashed without
   * cleaning up its detached codex app-server process.
   * Tries multiple tools for cross-platform compatibility (Linux, macOS, WSL, Windows).
   */
  private killStaleProcess(): void {
    if (process.platform !== 'win32') {
      // Unix: try fuser first, then lsof
      try {
        const r = Bun.spawnSync(['fuser', '-k', `${this.wsPort}/tcp`], {
          stdio: ['ignore', 'ignore', 'ignore'],
          timeout: 5000,
        });
        if (r.exitCode === 0) {
          console.log(`[codex] Killed stale process on port ${this.wsPort} (fuser)`);
          return;
        }
      } catch {
        // fuser not available
      }

      try {
        const r = Bun.spawnSync(['lsof', '-ti', `tcp:${this.wsPort}`], {
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 5000,
        });
        const output = new TextDecoder().decode(r.stdout as Uint8Array).trim();
        if (output) {
          for (const line of output.split('\n')) {
            const pid = parseInt(line.trim(), 10);
            if (pid > 0) {
              try {
                process.kill(pid, 9);
              } catch {
                // Already dead
              }
            }
          }
          console.log(`[codex] Killed stale process on port ${this.wsPort} (lsof)`);
          return;
        }
      } catch {
        // lsof not available
      }
    }

    // Windows native or WSL fallback: try PowerShell to kill Windows-side processes
    try {
      const ps = process.platform === 'win32' ? 'powershell' : 'powershell.exe';
      Bun.spawnSync(
        [
          ps,
          '-NoProfile',
          '-Command',
          `Get-NetTCPConnection -LocalPort ${this.wsPort} -State Listen -ErrorAction SilentlyContinue | ` +
            `ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`,
        ],
        { stdio: ['ignore', 'ignore', 'ignore'], timeout: 10000 },
      );
    } catch {
      // PowerShell not available — proceed anyway
    }
  }

  /**
   * Spawn the app-server process with WebSocket listener.
   */
  private async spawnProcess(): Promise<void> {
    // Kill any orphaned process still holding the port from a previous run
    this.killStaleProcess();

    const namespaces = CORE_SERVERS;
    const args = getCodexAppServerArgs(namespaces);

    // Add WebSocket listener
    args.push('--listen', `ws://127.0.0.1:${this.wsPort}`);

    // Add model if specified
    if (this.config.model) {
      args.push('-c', `model=${this.config.model}`);

      // Point subagent roles at config files (written in start())
      if (this.tempDir) {
        for (const role of Object.keys(CODEX_AGENT_ROLES)) {
          args.push(
            '-c',
            `agents.${role}.config_file=${join(this.tempDir, 'agents', `${role}.toml`)}`,
          );
        }
      }
    }

    const spawnArgs = [...getCodexSpawnArgs(), ...args];
    try {
      this.process = Bun.spawn(spawnArgs, {
        cwd: STORAGE_DIR,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: {
          ...process.env,
          CI: '1',
          YAAR_MCP_TOKEN: getMcpToken(),
        },
      });
    } catch (err: unknown) {
      const isNotFound =
        err instanceof Error &&
        ('code' in err
          ? (err as NodeJS.ErrnoException).code === 'ENOENT'
          : err.message.includes('ENOENT'));
      if (isNotFound) {
        throw new Error(
          `Codex CLI not found (tried: ${spawnArgs[0]}). ` +
            `Install it (npm install -g @openai/codex) or place the codex binary next to the executable.`,
        );
      }
      throw err;
    }

    // Log stderr for debugging (async, runs in background)
    const stderrStream = this.process.stderr as ReadableStream<Uint8Array>;
    (async () => {
      try {
        const reader = stderrStream.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const message = decoder.decode(value).trim();
          if (message) {
            console.error(`[codex app-server stderr] ${message}`);
          }
        }
      } catch {
        // Stream closed
      }
    })();

    // Handle process exit (async, runs in background)
    this.process.exited.then((code) => {
      this.process = null;
      this.controlClient?.close();
      this.controlClient = null;

      for (const listener of this.exitListeners) {
        listener(code, null);
      }
    });
  }

  /**
   * Connect the control client to the app-server's WebSocket.
   * Retries connect + initialize as an atomic operation until the server is ready.
   */
  private async connectControlClient(): Promise<void> {
    const url = `ws://127.0.0.1:${this.wsPort}`;
    console.log(`[codex] Connecting control client to ${url}...`);

    this.controlClient = await this.connectAndInitialize(url, 20, 250);

    // Forward notifications from control client (used for account/login/completed)
    this.controlClient.on('notification', (method: string, params: unknown) => {
      for (const listener of this.notificationListeners) {
        listener(method, params);
      }
    });

    this.controlClient.on('error', (err: Error) => {
      for (const listener of this.errorListeners) {
        listener(err);
      }
    });

    console.log(`[codex] Control client connected`);
  }

  /**
   * Create a new WebSocket connection for a provider.
   * Performs the `initialize` handshake on the new connection.
   */
  async createConnection(): Promise<JsonRpcWsClient> {
    if (!this.process) {
      throw new Error('AppServer is not running');
    }

    return this.connectAndInitialize(`ws://127.0.0.1:${this.wsPort}`, 5, 100);
  }

  /**
   * Connect to the app-server WS and perform the initialize handshake.
   * Retries the full connect+initialize cycle to avoid leaking un-initialized connections.
   */
  private async connectAndInitialize(
    url: string,
    maxRetries: number,
    retryDelay: number,
  ): Promise<JsonRpcWsClient> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      let client: JsonRpcWsClient | null = null;
      try {
        client = await JsonRpcWsClient.connect(url, {
          requestTimeout: this.config.requestTimeout,
          maxRetries: 1,
          connectTimeout: 5000,
        });

        const result = await client.request<InitializeParams, InitializeResponse>(
          'initialize',
          this.initializeParams,
        );

        if (!this.initializeResult) {
          this.initializeResult = result;
        }

        return client;
      } catch (err) {
        client?.close();
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt === 0 || (attempt + 1) % 5 === 0) {
          console.warn(
            `[codex] connect+initialize attempt ${attempt + 1}/${maxRetries} failed: ${lastError.message}`,
          );
        }
        if (attempt < maxRetries - 1) {
          await new Promise((r) => setTimeout(r, retryDelay));
        }
      }
    }

    throw new Error(
      `Failed to connect+initialize ${url} after ${maxRetries} attempts: ${lastError?.message}`,
    );
  }

  /**
   * Stop the app-server process.
   */
  async stop(): Promise<void> {
    if (this.controlClient) {
      this.controlClient.close();
      this.controlClient = null;
    }

    if (this.process) {
      const pid = this.process.pid;

      // Kill the process
      this.process.kill();

      // Wait for the process to exit (with timeout)
      const exitPromise = this.process.exited;
      const timeoutPromise = new Promise<void>((resolve) => {
        setTimeout(() => {
          // Force kill if still alive
          if (pid) {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {
              // Already dead
            }
          }
          resolve();
        }, 5000);
      });
      await Promise.race([exitPromise, timeoutPromise]);

      this.process = null;
    }

    // Clean up temp directory
    if (this.tempDir) {
      try {
        await rm(this.tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
      this.tempDir = null;
    }
  }

  /**
   * Check if the app-server is running.
   */
  get isRunning(): boolean {
    return this.process !== null && this.controlClient !== null;
  }

  /**
   * Get the capabilities received from the initialize handshake.
   */
  getCapabilities(): InitializeResponse | null {
    return this.initializeResult;
  }

  // ============================================================================
  // Account API (via control client)
  // ============================================================================

  async accountRead(params: GetAccountParams): Promise<GetAccountResponse> {
    if (!this.controlClient) {
      throw new Error('AppServer is not running');
    }
    return this.controlClient.request<GetAccountParams, GetAccountResponse>('account/read', params);
  }

  async accountLoginStart(params: LoginAccountParams): Promise<LoginAccountResponse> {
    if (!this.controlClient) {
      throw new Error('AppServer is not running');
    }
    return this.controlClient.request<LoginAccountParams, LoginAccountResponse>(
      'account/login/start',
      params,
    );
  }

  async accountLoginCancel(params: CancelLoginAccountParams): Promise<CancelLoginAccountResponse> {
    if (!this.controlClient) {
      throw new Error('AppServer is not running');
    }
    return this.controlClient.request<CancelLoginAccountParams, CancelLoginAccountResponse>(
      'account/login/cancel',
      params,
    );
  }

  // ============================================================================
  // Event Emitter API
  // ============================================================================

  on(event: 'notification', listener: (method: string, params: unknown) => void): this;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): this {
    switch (event) {
      case 'notification':
        this.notificationListeners.push(listener as (method: string, params: unknown) => void);
        break;
      case 'exit':
        this.exitListeners.push(listener as (code: number | null, signal: string | null) => void);
        break;
      case 'error':
        this.errorListeners.push(listener as (error: Error) => void);
        break;
    }
    return this;
  }

  off(event: 'notification', listener: (method: string, params: unknown) => void): this;
  off(event: 'exit', listener: (code: number | null, signal: string | null) => void): this;
  off(event: 'error', listener: (error: Error) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(event: string, listener: (...args: any[]) => void): this {
    switch (event) {
      case 'notification':
        this.notificationListeners = this.notificationListeners.filter((l) => l !== listener);
        break;
      case 'exit':
        this.exitListeners = this.exitListeners.filter((l) => l !== listener);
        break;
      case 'error':
        this.errorListeners = this.errorListeners.filter((l) => l !== listener);
        break;
    }
    return this;
  }

  removeAllListeners(): this {
    this.notificationListeners = [];
    this.exitListeners = [];
    this.errorListeners = [];
    return this;
  }
}
