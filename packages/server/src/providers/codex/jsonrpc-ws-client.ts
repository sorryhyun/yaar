/**
 * WebSocket-based JSON-RPC client for codex app-server.
 *
 * Each CodexProvider gets its own WebSocket connection, eliminating
 * the single-turn serialization bottleneck of stdio transport.
 *
 * Message discrimination:
 * - has id AND method → server-initiated request → emit 'server_request'
 * - has id, no method → response to our request → resolve/reject pending
 * - no id             → notification → emit 'notification'
 */

import WebSocket from 'ws';
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcErrorResponse,
  JsonRpcNotification,
  JsonRpcMessage,
} from './types.js';

/**
 * Options for the WebSocket JSON-RPC client.
 */
export interface JsonRpcWsClientOptions {
  /** Timeout for requests in milliseconds (default: 30000) */
  requestTimeout?: number;
}

/**
 * Pending request waiting for a response.
 */
interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  method: string;
  timeoutId?: ReturnType<typeof setTimeout>;
}

/**
 * WebSocket-based JSON-RPC client for communicating with codex app-server.
 *
 * Based on the CDPClient pattern but with three-way message discrimination
 * (response vs server-request vs notification).
 */
export class JsonRpcWsClient {
  private ws: WebSocket;
  private nextId = 1;
  private pendingRequests = new Map<number, PendingRequest>();
  private readonly requestTimeout: number;
  private closed = false;

  // Event listeners (manual, no EventEmitter base for smaller footprint)
  private notificationListeners: Array<(method: string, params: unknown) => void> = [];
  private serverRequestListeners: Array<(id: number, method: string, params: unknown) => void> = [];
  private errorListeners: Array<(error: Error) => void> = [];
  private closeListeners: Array<() => void> = [];

  private constructor(ws: WebSocket, options: JsonRpcWsClientOptions = {}) {
    this.ws = ws;
    this.requestTimeout = options.requestTimeout ?? 30000;

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString()) as JsonRpcMessage;
        this.handleMessage(message);
      } catch {
        this.emitError(new Error(`Failed to parse JSON-RPC message: ${data.toString()}`));
      }
    });

    ws.on('close', () => {
      this.closed = true;
      this.rejectAll('WebSocket connection closed');
      for (const listener of this.closeListeners) listener();
    });

    ws.on('error', (err) => {
      this.emitError(err instanceof Error ? err : new Error(String(err)));
    });
  }

  /**
   * Connect to a WebSocket JSON-RPC server with retry logic.
   * Retries until the server is ready or maxRetries is exceeded.
   */
  static async connect(
    url: string,
    options: JsonRpcWsClientOptions & {
      /** Max connection attempts (default: 20) */
      maxRetries?: number;
      /** Delay between retries in ms (default: 250) */
      retryDelay?: number;
      /** Per-attempt connection timeout in ms (default: 5000) */
      connectTimeout?: number;
    } = {},
  ): Promise<JsonRpcWsClient> {
    const maxRetries = options.maxRetries ?? 20;
    const retryDelay = options.retryDelay ?? 250;
    const connectTimeout = options.connectTimeout ?? 5000;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const client = await new Promise<JsonRpcWsClient>((resolve, reject) => {
          let settled = false;

          const timer = setTimeout(() => {
            if (!settled) {
              settled = true;
              ws.close();
              reject(new Error('WebSocket connection timeout'));
            }
          }, connectTimeout);

          // Disable perMessageDeflate — Rust WS servers (tungstenite) may
          // reset the connection if extension negotiation fails.
          const ws = new WebSocket(url, { perMessageDeflate: false });

          ws.on('open', () => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve(new JsonRpcWsClient(ws, options));
            }
          });

          ws.on('unexpected-response', (_req, res) => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              reject(new Error(`WebSocket upgrade rejected: HTTP ${res.statusCode}`));
            }
          });

          ws.on('error', (err) => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              reject(err);
            }
            // Always try to close the socket to free resources
            try {
              ws.close();
            } catch {
              /* ignore */
            }
          });
        });

        return client;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < maxRetries - 1) {
          await new Promise((r) => setTimeout(r, retryDelay));
        }
      }
    }

    throw new Error(
      `Failed to connect to ${url} after ${maxRetries} attempts: ${lastError?.message}`,
    );
  }

  /**
   * Send a JSON-RPC request and wait for the response.
   */
  async request<TParams, TResult>(method: string, params?: TParams): Promise<TResult> {
    if (this.closed) {
      throw new Error('JsonRpcWsClient is closed');
    }

    const id = this.nextId++;
    const request: JsonRpcRequest<TParams> = {
      jsonrpc: '2.0',
      method,
      params,
      id,
    };

    return new Promise<TResult>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const pending = this.pendingRequests.get(id);
        if (pending) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request timed out: ${method} (id=${id})`));
        }
      }, this.requestTimeout);

      this.pendingRequests.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        method,
        timeoutId,
      });

      this.ws.send(JSON.stringify(request), (err) => {
        if (err) {
          this.pendingRequests.delete(id);
          clearTimeout(timeoutId);
          reject(err);
        }
      });
    });
  }

  /**
   * Send a JSON-RPC response to a server-initiated request.
   */
  respond(id: number, result: unknown): void {
    if (this.closed) return;
    const response = { jsonrpc: '2.0' as const, result, id };
    this.ws.send(JSON.stringify(response));
  }

  /**
   * Send a JSON-RPC error response to a server-initiated request.
   */
  respondError(id: number, code: number, message: string): void {
    if (this.closed) return;
    const response = { jsonrpc: '2.0' as const, error: { code, message }, id };
    this.ws.send(JSON.stringify(response));
  }

  /**
   * Send a notification (no response expected).
   */
  notify<TParams>(method: string, params?: TParams): void {
    if (this.closed) return;
    const notification: JsonRpcNotification<TParams> = {
      jsonrpc: '2.0',
      method,
      params,
    };
    this.ws.send(JSON.stringify(notification));
  }

  /**
   * Close the client and reject any pending requests.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll('JsonRpcWsClient closed');
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }

  /**
   * Whether the WebSocket connection is open.
   */
  get isConnected(): boolean {
    return !this.closed && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Get the number of pending requests.
   */
  get pendingCount(): number {
    return this.pendingRequests.size;
  }

  // ── Event Emitter API ────────────────────────────────────────────────

  on(event: 'notification', listener: (method: string, params: unknown) => void): this;
  on(
    event: 'server_request',
    listener: (id: number, method: string, params: unknown) => void,
  ): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: () => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): this {
    switch (event) {
      case 'notification':
        this.notificationListeners.push(listener as (method: string, params: unknown) => void);
        break;
      case 'server_request':
        this.serverRequestListeners.push(
          listener as (id: number, method: string, params: unknown) => void,
        );
        break;
      case 'error':
        this.errorListeners.push(listener as (error: Error) => void);
        break;
      case 'close':
        this.closeListeners.push(listener as () => void);
        break;
    }
    return this;
  }

  off(event: 'notification', listener: (method: string, params: unknown) => void): this;
  off(
    event: 'server_request',
    listener: (id: number, method: string, params: unknown) => void,
  ): this;
  off(event: 'error', listener: (error: Error) => void): this;
  off(event: 'close', listener: () => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(event: string, listener: (...args: any[]) => void): this {
    switch (event) {
      case 'notification':
        this.notificationListeners = this.notificationListeners.filter((l) => l !== listener);
        break;
      case 'server_request':
        this.serverRequestListeners = this.serverRequestListeners.filter((l) => l !== listener);
        break;
      case 'error':
        this.errorListeners = this.errorListeners.filter((l) => l !== listener);
        break;
      case 'close':
        this.closeListeners = this.closeListeners.filter((l) => l !== listener);
        break;
    }
    return this;
  }

  removeAllListeners(): this {
    this.notificationListeners = [];
    this.serverRequestListeners = [];
    this.errorListeners = [];
    this.closeListeners = [];
    return this;
  }

  // ── Internals ────────────────────────────────────────────────────────

  /**
   * Handle a parsed JSON-RPC message.
   *
   * Discrimination logic (same as stdio client):
   * - has id AND method → server-initiated request
   * - has id, no method → response to our request
   * - no id             → notification
   */
  private handleMessage(message: JsonRpcMessage): void {
    if ('id' in message && message.id !== undefined) {
      // Server-initiated request: has both id and method
      if ('method' in message && typeof (message as { method?: string }).method === 'string') {
        const req = message as { id: number; method: string; params?: unknown };
        for (const listener of this.serverRequestListeners) {
          listener(req.id, req.method, req.params);
        }
        return;
      }

      // Response to a client-initiated request
      const pending = this.pendingRequests.get(message.id);
      if (!pending) return;

      this.pendingRequests.delete(message.id);
      if (pending.timeoutId) {
        clearTimeout(pending.timeoutId);
      }

      if ('error' in message) {
        const errorResponse = message as JsonRpcErrorResponse;
        pending.reject(
          new Error(`${errorResponse.error.message} (code: ${errorResponse.error.code})`),
        );
      } else {
        const response = message as JsonRpcResponse;
        pending.resolve(response.result);
      }
    } else {
      // Notification
      const notification = message as JsonRpcNotification;
      for (const listener of this.notificationListeners) {
        listener(notification.method, notification.params);
      }
    }
  }

  private emitError(error: Error): void {
    for (const listener of this.errorListeners) {
      listener(error);
    }
  }

  private rejectAll(reason: string): void {
    for (const [, pending] of this.pendingRequests) {
      if (pending.timeoutId) {
        clearTimeout(pending.timeoutId);
      }
      pending.reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }
}
