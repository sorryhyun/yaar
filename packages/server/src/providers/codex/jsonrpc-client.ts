/**
 * JSON-RPC client for stdio communication with codex app-server.
 *
 * Handles:
 * - Sending requests with auto-incrementing IDs
 * - Correlating responses to requests
 * - Emitting notifications as events
 * - Line-based parsing of JSON-RPC messages
 */

import { EventEmitter } from 'events';
import type { Readable, Writable } from 'stream';
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcErrorResponse,
  JsonRpcNotification,
  JsonRpcMessage,
} from './types.js';

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
 * Options for the JSON-RPC client.
 */
export interface JsonRpcClientOptions {
  /** Timeout for requests in milliseconds (default: 30000) */
  requestTimeout?: number;
}

/**
 * JSON-RPC client that communicates over stdio streams.
 *
 * @example
 * ```ts
 * const client = new JsonRpcClient(process.stdin, process.stdout);
 * client.on('notification', (method, params) => {
 *   console.log('Received:', method, params);
 * });
 *
 * const result = await client.request('thread/start', { baseInstructions: '...' });
 * ```
 */
export class JsonRpcClient extends EventEmitter {
  private nextId = 1;
  private pendingRequests = new Map<number, PendingRequest>();
  private buffer = '';
  private readonly requestTimeout: number;
  private closed = false;

  constructor(
    private readonly stdin: Writable,
    private readonly stdout: Readable,
    options: JsonRpcClientOptions = {}
  ) {
    super();
    this.requestTimeout = options.requestTimeout ?? 30000;
    this.setupStdoutHandler();
  }

  /**
   * Send a JSON-RPC request and wait for the response.
   */
  async request<TParams, TResult>(
    method: string,
    params?: TParams
  ): Promise<TResult> {
    if (this.closed) {
      throw new Error('JsonRpcClient is closed');
    }

    const id = this.nextId++;
    const request: JsonRpcRequest<TParams> = {
      jsonrpc: '2.0',
      method,
      params,
      id,
    };

    return new Promise<TResult>((resolve, reject) => {
      // Set up timeout
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

      // Send the request
      const line = JSON.stringify(request) + '\n';
      this.stdin.write(line, (err) => {
        if (err) {
          this.pendingRequests.delete(id);
          clearTimeout(timeoutId);
          reject(err);
        }
      });
    });
  }

  /**
   * Send a notification (no response expected).
   */
  notify<TParams>(method: string, params?: TParams): void {
    if (this.closed) {
      return;
    }

    const notification: JsonRpcNotification<TParams> = {
      jsonrpc: '2.0',
      method,
      params,
    };

    const line = JSON.stringify(notification) + '\n';
    this.stdin.write(line);
  }

  /**
   * Close the client and reject any pending requests.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;

    // Reject all pending requests
    for (const [, pending] of this.pendingRequests) {
      if (pending.timeoutId) {
        clearTimeout(pending.timeoutId);
      }
      pending.reject(new Error('JsonRpcClient closed'));
    }
    this.pendingRequests.clear();

    this.emit('close');
  }

  /**
   * Set up the stdout handler to parse JSON-RPC messages.
   */
  private setupStdoutHandler(): void {
    this.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      this.processBuffer();
    });

    this.stdout.on('end', () => {
      this.close();
    });

    this.stdout.on('error', (err) => {
      this.emit('error', err);
      this.close();
    });
  }

  /**
   * Process the buffer for complete JSON-RPC messages.
   * Messages are newline-delimited.
   */
  private processBuffer(): void {
    let newlineIndex: number;

    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line.length === 0) continue;

      try {
        const message = JSON.parse(line) as JsonRpcMessage;
        this.handleMessage(message);
      } catch (err) {
        // Log parse errors but continue processing
        this.emit('error', new Error(`Failed to parse JSON-RPC message: ${line}`));
      }
    }
  }

  /**
   * Handle a parsed JSON-RPC message.
   */
  private handleMessage(message: JsonRpcMessage): void {
    // Check if this is a response (has id)
    if ('id' in message && message.id !== undefined) {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) {
        // Response for unknown request, ignore
        return;
      }

      this.pendingRequests.delete(message.id);
      if (pending.timeoutId) {
        clearTimeout(pending.timeoutId);
      }

      // Check for error response
      if ('error' in message) {
        const errorResponse = message as JsonRpcErrorResponse;
        pending.reject(
          new Error(`${errorResponse.error.message} (code: ${errorResponse.error.code})`)
        );
      } else {
        const response = message as JsonRpcResponse;
        pending.resolve(response.result);
      }
    } else {
      // This is a notification
      const notification = message as JsonRpcNotification;
      this.emit('notification', notification.method, notification.params);
    }
  }

  /**
   * Get the number of pending requests.
   */
  get pendingCount(): number {
    return this.pendingRequests.size;
  }
}
