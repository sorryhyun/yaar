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

import { spawn, type ChildProcess } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { JsonRpcWsClient } from './jsonrpc-ws-client.js';
import { getMcpToken, MCP_SERVERS } from '../../mcp/index.js';
import {
  getCodexBin,
  getCodexAppServerArgs,
  APP_DEV_ENABLED,
  getCodexWsPort,
} from '../../config.js';
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
  /** Model to use (default: gpt-5.3-codex) */
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
  private process: ChildProcess | null = null;
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

    // Create an isolated temp directory to prevent file contamination
    this.tempDir = await mkdtemp(join(tmpdir(), 'codex-'));

    await this.spawnProcess();

    // Connect the control client + initialize (retry loop until server is ready)
    await this.connectControlClient();
  }

  /**
   * Spawn the app-server process with WebSocket listener.
   */
  private async spawnProcess(): Promise<void> {
    const namespaces = APP_DEV_ENABLED ? MCP_SERVERS : MCP_SERVERS.filter((ns) => ns !== 'dev');
    const args = getCodexAppServerArgs(namespaces);

    // Add WebSocket listener
    args.push('--listen', `ws://127.0.0.1:${this.wsPort}`);

    // Add model if specified
    if (this.config.model) {
      args.push('-c', `model=${this.config.model}`);
    }

    const codexBin = getCodexBin();
    this.process = spawn(codexBin, args, {
      cwd: this.tempDir ?? undefined,
      shell: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        CI: '1',
        YAAR_MCP_TOKEN: getMcpToken(),
      },
    });

    // Log stderr for debugging
    this.process.stderr?.on('data', (data: Buffer) => {
      const message = data.toString().trim();
      if (message) {
        console.error(`[codex app-server stderr] ${message}`);
      }
    });

    // Handle process exit
    this.process.on('exit', (code, signal) => {
      this.process = null;
      this.controlClient?.close();
      this.controlClient = null;

      for (const listener of this.exitListeners) {
        listener(code, signal);
      }
    });

    // Handle process error
    this.process.on('error', (err) => {
      for (const listener of this.errorListeners) {
        listener(err);
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
      this.process.kill('SIGTERM');

      // Wait for the process to exit
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (this.process) {
            this.process.kill('SIGKILL');
          }
          resolve();
        }, 5000);

        this.process!.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });

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
