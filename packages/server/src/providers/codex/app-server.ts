/**
 * App-server process manager for Codex.
 *
 * Manages the lifecycle of a `codex app-server` child process:
 * - Spawns with disabled tools and isolated working directory
 * - Provides JSON-RPC client for communication
 * - Owned by WarmPool singleton (single owner, no refcounting)
 */

import { spawn, type ChildProcess } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { JsonRpcClient, type JsonRpcClientOptions } from './jsonrpc-client.js';
import { getMcpToken } from '../../mcp/index.js';
import { getCodexBin, getCodexAppServerArgs } from '../../config.js';
import type {
  ThreadStartParams,
  ThreadStartResponse,
  TurnStartParams,
  TurnStartResponse,
  TurnInterruptParams,
  TurnInterruptResponse,
  TurnSteerParams,
  TurnSteerResponse,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadForkParams,
  ThreadForkResponse,
  InitializeParams,
  InitializeResponse,
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
  /** Emitted when a notification is received from the server */
  notification: (method: string, params: unknown) => void;
  /** Emitted when the server process exits */
  exit: (code: number | null, signal: string | null) => void;
  /** Emitted when an error occurs */
  error: (error: Error) => void;
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
  private isShuttingDown = false;
  private readonly config: AppServerConfig;

  // Turn serialization: only one turn runs at a time on a single app-server
  private turnQueue: Array<{ resolve: () => void }> = [];
  private turnActive = false;

  // Capabilities received from initialize handshake
  private initializeResult: InitializeResponse | null = null;

  // Event listeners
  private notificationListeners: Array<(method: string, params: unknown) => void> = [];
  private serverRequestListeners: Array<(id: number, method: string, params: unknown) => void> = [];
  private exitListeners: Array<(code: number | null, signal: string | null) => void> = [];
  private errorListeners: Array<(error: Error) => void> = [];

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

    this.initializeResult = await this.client.request<InitializeParams, InitializeResponse>(
      'initialize',
      {
        clientInfo: {
          name: 'yaar',
          title: 'YAAR Desktop',
          version: '1.0.0',
        },
        capabilities: {
          experimentalApi: true,
        },
      }
    );
  }

  /**
   * Spawn the app-server process.
   */
  private async spawnProcess(): Promise<void> {
    const args = getCodexAppServerArgs();

    // Add model if specified
    if (this.config.model) {
      args.push('-c', `model=${this.config.model}`);
    }

    const codexBin = getCodexBin();
    this.process = spawn(codexBin, args, {
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

    // Forward server-initiated requests
    this.client.on('server_request', (id: number, method: string, params: unknown) => {
      for (const listener of this.serverRequestListeners) {
        listener(id, method, params);
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
    this.process.on('exit', (code, signal) => {
      this.process = null;
      this.client?.close();
      this.client = null;

      // Emit exit event
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
   * Stop the app-server process.
   */
  async stop(): Promise<void> {
    this.isShuttingDown = true;

    // Drain the turn queue so any providers blocked on acquireTurn() unblock.
    // They will fail at the next RPC call (client is null) which is caught by query().
    for (const waiter of this.turnQueue) {
      waiter.resolve();
    }
    this.turnQueue = [];
    this.turnActive = false;

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

  /**
   * Get the capabilities received from the initialize handshake.
   */
  getCapabilities(): InitializeResponse | null {
    return this.initializeResult;
  }

  /**
   * Send a JSON-RPC response to a server-initiated request.
   */
  respond(id: number, result: unknown): void {
    this.client?.respond(id, result);
  }

  /**
   * Send a JSON-RPC error response to a server-initiated request.
   */
  respondError(id: number, code: number, message: string): void {
    this.client?.respondError(id, code, message);
  }

  // ============================================================================
  // Thread/Turn API
  // ============================================================================

  /**
   * Start a new thread.
   */
  async threadStart(params: Omit<ThreadStartParams, 'experimentalRawEvents'> = {}): Promise<ThreadStartResponse> {
    if (!this.client) {
      throw new Error('AppServer is not running');
    }
    const fullParams: ThreadStartParams = { experimentalRawEvents: false, ...params };
    return this.client.request<ThreadStartParams, ThreadStartResponse>(
      'thread/start',
      fullParams
    );
  }

  /**
   * Resume an existing thread.
   * Returns the thread object so callers can validate it was properly loaded.
   */
  async threadResume(params: ThreadResumeParams): Promise<ThreadResumeResponse> {
    if (!this.client) {
      throw new Error('AppServer is not running');
    }
    return this.client.request<ThreadResumeParams, ThreadResumeResponse>('thread/resume', params);
  }

  /**
   * Start a turn in a thread.
   */
  async turnStart(params: TurnStartParams): Promise<TurnStartResponse> {
    if (!this.client) {
      throw new Error('AppServer is not running');
    }
    return this.client.request<TurnStartParams, TurnStartResponse>('turn/start', params);
  }

  /**
   * Steer an in-flight turn by injecting additional input.
   */
  async turnSteer(params: TurnSteerParams): Promise<TurnSteerResponse> {
    if (!this.client) {
      throw new Error('AppServer is not running');
    }
    return this.client.request<TurnSteerParams, TurnSteerResponse>('turn/steer', params);
  }

  /**
   * Interrupt an in-flight turn.
   */
  async turnInterrupt(params: TurnInterruptParams): Promise<TurnInterruptResponse> {
    if (!this.client) {
      throw new Error('AppServer is not running');
    }
    return this.client.request<TurnInterruptParams, TurnInterruptResponse>('turn/interrupt', params);
  }

  /**
   * Fork an existing thread into a new independent thread.
   * The forked thread inherits the parent's conversation history.
   */
  async threadFork(params: ThreadForkParams): Promise<ThreadForkResponse> {
    if (!this.client) {
      throw new Error('AppServer is not running');
    }
    return this.client.request<ThreadForkParams, ThreadForkResponse>(
      'thread/fork',
      params
    );
  }

  // ============================================================================
  // Turn Serialization
  // ============================================================================

  /**
   * Acquire exclusive turn access. Only one turn runs at a time per app-server
   * because notifications are not tagged with thread/turn IDs.
   */
  async acquireTurn(): Promise<void> {
    if (!this.turnActive) {
      this.turnActive = true;
      return;
    }
    return new Promise<void>((resolve) => {
      this.turnQueue.push({ resolve });
    });
  }

  /**
   * Release turn access, allowing the next queued turn to proceed.
   */
  releaseTurn(): void {
    const next = this.turnQueue.shift();
    if (next) {
      next.resolve();
    } else {
      this.turnActive = false;
    }
  }

  // ============================================================================
  // Event Emitter API
  // ============================================================================

  on(event: 'notification', listener: (method: string, params: unknown) => void): this;
  on(event: 'server_request', listener: (id: number, method: string, params: unknown) => void): this;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): this {
    switch (event) {
      case 'notification':
        this.notificationListeners.push(listener as (method: string, params: unknown) => void);
        break;
      case 'server_request':
        this.serverRequestListeners.push(listener as (id: number, method: string, params: unknown) => void);
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
  off(event: 'server_request', listener: (id: number, method: string, params: unknown) => void): this;
  off(event: 'exit', listener: (code: number | null, signal: string | null) => void): this;
  off(event: 'error', listener: (error: Error) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(event: string, listener: (...args: any[]) => void): this {
    switch (event) {
      case 'notification':
        this.notificationListeners = this.notificationListeners.filter((l) => l !== listener);
        break;
      case 'server_request':
        this.serverRequestListeners = this.serverRequestListeners.filter((l) => l !== listener);
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

  /**
   * Remove all event listeners.
   */
  removeAllListeners(): this {
    this.notificationListeners = [];
    this.serverRequestListeners = [];
    this.exitListeners = [];
    this.errorListeners = [];
    return this;
  }
}
