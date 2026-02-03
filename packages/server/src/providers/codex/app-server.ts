/**
 * App-server process manager for Codex.
 *
 * Manages the lifecycle of a `codex app-server` child process:
 * - Spawns with disabled tools and isolated working directory
 * - Auto-restarts on crash (up to MAX_RESTARTS)
 * - Provides JSON-RPC client for communication
 */

import { spawn, type ChildProcess } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { JsonRpcClient, type JsonRpcClientOptions } from './jsonrpc-client.js';
import { getMcpToken } from '../../mcp/index.js';
import type {
  ThreadStartParams,
  ThreadStartResult,
  TurnStartParams,
  ThreadResumeParams,
  InitializeParams,
  InitializeResult,
} from './types.js';

// MCP server port (same as main server)
const MCP_PORT = parseInt(process.env.PORT ?? '8000', 10);

const MAX_RESTARTS = 3;
const RESTART_DELAY_MS = 1000;

/**
 * Configuration for the app-server.
 */
export interface AppServerConfig {
  /** Model to use (default: gpt-5.2) */
  model?: string;
  /** Request timeout in milliseconds */
  requestTimeout?: number;
}

/**
 * Events emitted by the AppServer.
 */
export interface AppServerEvents {
  /** Emitted when a notification is received from the server */
  notification: (method: string, params: unknown) => void;
  /** Emitted when the server process exits */
  exit: (code: number | null, signal: string | null) => void;
  /** Emitted when an error occurs */
  error: (error: Error) => void;
  /** Emitted when the server restarts */
  restart: (attempt: number) => void;
}

/**
 * Manages a codex app-server child process.
 *
 * @example
 * ```ts
 * const server = new AppServer();
 * await server.start();
 *
 * server.on('notification', (method, params) => {
 *   console.log('Notification:', method, params);
 * });
 *
 * const { threadId } = await server.threadStart({ baseInstructions: '...' });
 * await server.turnStart({ threadId, input: [{ type: 'text', text: 'Hello!' }] });
 *
 * await server.stop();
 * ```
 */
export class AppServer {
  private process: ChildProcess | null = null;
  private client: JsonRpcClient | null = null;
  private tempDir: string | null = null;
  private restartCount = 0;
  private isShuttingDown = false;
  private readonly config: AppServerConfig;

  // Event listeners
  private notificationListeners: Array<(method: string, params: unknown) => void> = [];
  private exitListeners: Array<(code: number | null, signal: string | null) => void> = [];
  private errorListeners: Array<(error: Error) => void> = [];
  private restartListeners: Array<(attempt: number) => void> = [];

  constructor(config: AppServerConfig = {}) {
    this.config = config;
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

    // Initialize the app-server (required before any other operations)
    await this.initialize();
  }

  /**
   * Initialize the app-server with client info.
   * This must be called before any thread/turn operations.
   */
  private async initialize(): Promise<void> {
    if (!this.client) {
      throw new Error('AppServer client is not available');
    }

    await this.client.request<InitializeParams, InitializeResult>(
      'initialize',
      {
        clientInfo: {
          name: 'yaar',
          version: '1.0.0',
        },
      }
    );
  }

  /**
   * Spawn the app-server process.
   */
  private async spawnProcess(): Promise<void> {
    const args = [
      'app-server',
      // Disable shell tool
      '-c', 'features.shell_tool=false',
      // Disable web search
      '-c', 'web_search=disabled',
      // Configure YAAR MCP server
      '-c', `mcp_servers.yaar.url=http://127.0.0.1:${MCP_PORT}/mcp`,
      '-c', 'mcp_servers.yaar.bearer_token_env_var=YAAR_MCP_TOKEN',
      '-c', 'model_reasoning_effort = "medium"',
    ];

    // Add model if specified
    if (this.config.model) {
      args.push('-c', `model=${this.config.model}`);
    }

    this.process = spawn('codex', args, {
      cwd: this.tempDir ?? undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Ensure no interactive prompts
        CI: '1',
        // MCP authentication token
        YAAR_MCP_TOKEN: getMcpToken(),
      },
    });

    // Set up JSON-RPC client
    const clientOptions: JsonRpcClientOptions = {};
    if (this.config.requestTimeout) {
      clientOptions.requestTimeout = this.config.requestTimeout;
    }

    this.client = new JsonRpcClient(
      this.process.stdin!,
      this.process.stdout!,
      clientOptions
    );

    // Forward notifications
    this.client.on('notification', (method: string, params: unknown) => {
      for (const listener of this.notificationListeners) {
        listener(method, params);
      }
    });

    // Handle client errors
    this.client.on('error', (err: Error) => {
      for (const listener of this.errorListeners) {
        listener(err);
      }
    });

    // Log stderr for debugging
    this.process.stderr?.on('data', (data: Buffer) => {
      const message = data.toString().trim();
      if (message) {
        console.error(`[codex app-server stderr] ${message}`);
      }
    });

    // Handle process exit
    this.process.on('exit', async (code, signal) => {
      this.process = null;
      this.client?.close();
      this.client = null;

      // Emit exit event
      for (const listener of this.exitListeners) {
        listener(code, signal);
      }

      // Auto-restart if not shutting down and under restart limit
      if (!this.isShuttingDown && this.restartCount < MAX_RESTARTS) {
        this.restartCount++;
        for (const listener of this.restartListeners) {
          listener(this.restartCount);
        }

        // Delay before restart
        await new Promise((resolve) => setTimeout(resolve, RESTART_DELAY_MS));

        try {
          await this.spawnProcess();
          await this.initialize();
        } catch (err) {
          for (const listener of this.errorListeners) {
            listener(err instanceof Error ? err : new Error(String(err)));
          }
        }
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
   * Stop the app-server process.
   */
  async stop(): Promise<void> {
    this.isShuttingDown = true;

    if (this.client) {
      this.client.close();
      this.client = null;
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

    this.restartCount = 0;
    this.isShuttingDown = false;
  }

  /**
   * Check if the app-server is running.
   */
  get isRunning(): boolean {
    return this.process !== null && this.client !== null;
  }

  /**
   * Get the JSON-RPC client for direct access.
   */
  getClient(): JsonRpcClient | null {
    return this.client;
  }

  // ============================================================================
  // Thread/Turn API
  // ============================================================================

  /**
   * Start a new thread.
   */
  async threadStart(params: ThreadStartParams = {}): Promise<ThreadStartResult> {
    if (!this.client) {
      throw new Error('AppServer is not running');
    }
    return this.client.request<ThreadStartParams, ThreadStartResult>(
      'thread/start',
      params
    );
  }

  /**
   * Resume an existing thread.
   */
  async threadResume(params: ThreadResumeParams): Promise<void> {
    if (!this.client) {
      throw new Error('AppServer is not running');
    }
    await this.client.request<ThreadResumeParams, void>('thread/resume', params);
  }

  /**
   * Start a turn in a thread.
   */
  async turnStart(params: TurnStartParams): Promise<void> {
    if (!this.client) {
      throw new Error('AppServer is not running');
    }
    await this.client.request<TurnStartParams, void>('turn/start', params);
  }

  // ============================================================================
  // Event Emitter API
  // ============================================================================

  on(event: 'notification', listener: (method: string, params: unknown) => void): this;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'restart', listener: (attempt: number) => void): this;
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
      case 'restart':
        this.restartListeners.push(listener as (attempt: number) => void);
        break;
    }
    return this;
  }

  off(event: 'notification', listener: (method: string, params: unknown) => void): this;
  off(event: 'exit', listener: (code: number | null, signal: string | null) => void): this;
  off(event: 'error', listener: (error: Error) => void): this;
  off(event: 'restart', listener: (attempt: number) => void): this;
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
      case 'restart':
        this.restartListeners = this.restartListeners.filter((l) => l !== listener);
        break;
    }
    return this;
  }

  /**
   * Remove all event listeners.
   */
  removeAllListeners(): this {
    this.notificationListeners = [];
    this.exitListeners = [];
    this.errorListeners = [];
    this.restartListeners = [];
    return this;
  }
}
