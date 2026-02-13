/**
 * Lightweight Chrome DevTools Protocol client.
 *
 * Communicates over WebSocket using the CDP JSON-RPC protocol.
 * No external dependencies beyond the `ws` package already in the project.
 */

import WebSocket from 'ws';

export class CDPClient {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();
  private eventHandlers = new Map<string, Set<(params: unknown) => void>>();
  private closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (data) => this.handleMessage(data.toString()));
    ws.on('close', () => {
      this.closed = true;
      this.rejectAll('Connection closed');
    });
    ws.on('error', () => {
      /* handled by close */
    });
  }

  static async connect(url: string, timeout = 5000): Promise<CDPClient> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('CDP connection timeout'));
      }, timeout);

      const ws = new WebSocket(url);
      ws.on('open', () => {
        clearTimeout(timer);
        resolve(new CDPClient(ws));
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async send(method: string, params?: Record<string, unknown>): Promise<any> {
    if (this.closed) throw new Error('CDP connection closed');

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }

  on(event: string, handler: (params: unknown) => void): void {
    let handlers = this.eventHandlers.get(event);
    if (!handlers) {
      handlers = new Set();
      this.eventHandlers.set(event, handlers);
    }
    handlers.add(handler);
  }

  off(event: string, handler: (params: unknown) => void): void {
    this.eventHandlers.get(event)?.delete(handler);
  }

  async waitForEvent(event: string, timeout: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(event, handler);
        reject(new Error(`Timeout waiting for ${event}`));
      }, timeout);

      const handler = (params: unknown) => {
        clearTimeout(timer);
        this.off(event, handler);
        resolve(params);
      };

      this.on(event, handler);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll('Client closed');
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private handleMessage(data: string): void {
    try {
      const msg = JSON.parse(data);

      if ('id' in msg) {
        const pending = this.pending.get(msg.id);
        if (pending) {
          this.pending.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(msg.error.message || 'CDP error'));
          } else {
            pending.resolve(msg.result);
          }
        }
      } else if ('method' in msg) {
        const handlers = this.eventHandlers.get(msg.method);
        if (handlers) {
          for (const h of handlers) h(msg.params);
        }
      }
    } catch {
      /* malformed message */
    }
  }

  private rejectAll(reason: string): void {
    for (const [, pending] of this.pending) {
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }
}
