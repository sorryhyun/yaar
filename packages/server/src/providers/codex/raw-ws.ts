/**
 * Raw WebSocket client using node:net TCP — completely bypasses both Bun's
 * native WebSocket (tungstenite compat issues) and Bun's node:http (doesn't
 * fire the 'upgrade' event for 101 responses).
 *
 * Sends the HTTP upgrade request as raw bytes over a TCP socket, parses the
 * 101 response, then does WebSocket framing on the same connection.
 *
 * Provides a `ws`-module compatible EventEmitter API so JsonRpcWsClient
 * can use .on('open')/.on('message')/.on('close')/.on('error') uniformly.
 */

import { EventEmitter } from 'node:events';
import { Socket } from 'node:net';
import { randomBytes, createHash } from 'node:crypto';

// WebSocket opcodes
const OP_CONTINUATION = 0x00;
const OP_TEXT = 0x01;
const OP_CLOSE = 0x08;
const OP_PING = 0x09;
const OP_PONG = 0x0a;

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const CRLF = '\r\n';

/**
 * ws-module compatible WebSocket client using raw TCP.
 *
 * Events emitted:
 * - 'open' — connection established
 * - 'message' (data: Buffer) — text/binary frame received
 * - 'close' — connection closed
 * - 'error' (err: Error) — error occurred
 * - 'unexpected-response' (req, res) — server returned non-101
 */
export class RawWebSocket extends EventEmitter {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = RawWebSocket.CONNECTING;

  private socket: Socket | null = null;
  private buf = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  /** True once we've parsed the HTTP 101 response and switched to WS framing */
  private upgraded = false;
  private wsKey = '';

  constructor(url: string) {
    super();
    this.connect(url);
  }

  // ── TCP connect + HTTP upgrade handshake ───────────────────────────────

  private connect(url: string): void {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const port = parseInt(parsed.port, 10) || 80;
    const path = parsed.pathname + parsed.search;

    this.wsKey = randomBytes(16).toString('base64');

    const socket = new Socket();
    this.socket = socket;

    socket.connect(port, host, () => {
      // Send HTTP upgrade request
      const request =
        `GET ${path} HTTP/1.1${CRLF}` +
        `Host: ${host}:${port}${CRLF}` +
        `Connection: Upgrade${CRLF}` +
        `Upgrade: websocket${CRLF}` +
        `Sec-WebSocket-Key: ${this.wsKey}${CRLF}` +
        `Sec-WebSocket-Version: 13${CRLF}` +
        CRLF;
      socket.write(request);
    });

    socket.on('data', (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk]);

      if (!this.upgraded) {
        this.parseUpgradeResponse();
      } else {
        this.drain();
      }
    });

    socket.on('close', () => {
      if (this.readyState !== RawWebSocket.CLOSED) {
        this.readyState = RawWebSocket.CLOSED;
        this.emit('close');
      }
    });

    socket.on('error', (err: Error) => {
      if (this.readyState !== RawWebSocket.CLOSED) {
        this.readyState = RawWebSocket.CLOSED;
        this.emit('error', err);
      }
    });
  }

  /**
   * Parse the HTTP 101 Switching Protocols response from the buffer.
   * Once found, switch to WebSocket frame parsing mode.
   */
  private parseUpgradeResponse(): void {
    // Look for end of HTTP headers (\r\n\r\n)
    const headerEnd = this.buf.indexOf('\r\n\r\n');
    if (headerEnd === -1) return; // need more data

    const headerStr = this.buf.subarray(0, headerEnd).toString('utf-8');
    const remaining = this.buf.subarray(headerEnd + 4);

    // Parse status line
    const statusLine = headerStr.split(CRLF)[0];
    const statusMatch = statusLine.match(/^HTTP\/\d\.\d (\d+)/);
    const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : 0;

    if (statusCode !== 101) {
      this.readyState = RawWebSocket.CLOSED;
      this.emit('unexpected-response', null, { statusCode });
      this.socket?.destroy();
      return;
    }

    // Parse headers
    const headers = new Map<string, string>();
    for (const line of headerStr.split(CRLF).slice(1)) {
      const idx = line.indexOf(':');
      if (idx !== -1) {
        headers.set(line.substring(0, idx).trim().toLowerCase(), line.substring(idx + 1).trim());
      }
    }

    // Verify Sec-WebSocket-Accept
    const expected = createHash('sha1')
      .update(this.wsKey + WS_GUID)
      .digest('base64');
    if (headers.get('sec-websocket-accept') !== expected) {
      this.readyState = RawWebSocket.CLOSED;
      this.emit('error', new Error('Invalid Sec-WebSocket-Accept'));
      this.socket?.destroy();
      return;
    }

    // Upgrade successful
    this.upgraded = true;
    this.readyState = RawWebSocket.OPEN;
    this.buf = remaining;

    this.emit('open');

    // Process any WebSocket frames that arrived with the upgrade response
    if (this.buf.length > 0) {
      this.drain();
    }
  }

  // ── Frame parsing ─────────────────────────────────────────────────────

  private drain(): void {
    while (this.buf.length >= 2) {
      const b0 = this.buf[0];
      const b1 = this.buf[1];

      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;

      let offset = 2;

      if (payloadLen === 126) {
        if (this.buf.length < 4) return;
        payloadLen = this.buf.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this.buf.length < 10) return;
        const hi = this.buf.readUInt32BE(2);
        const lo = this.buf.readUInt32BE(6);
        payloadLen = hi * 0x1_0000_0000 + lo;
        offset = 10;
      }

      if (masked) offset += 4;

      const total = offset + payloadLen;
      if (this.buf.length < total) return; // need more data

      let payload = this.buf.subarray(offset, total);

      if (masked) {
        const maskKey = this.buf.subarray(offset - 4, offset);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i & 3];
        }
      }

      this.buf = this.buf.subarray(total);

      // Continuation frames
      if (opcode === OP_CONTINUATION) {
        this.fragments.push(payload);
        if (fin) {
          const assembled = Buffer.concat(this.fragments);
          this.fragments = [];
          this.emit('message', assembled);
        }
        continue;
      }

      // Control frames
      if (opcode === OP_CLOSE) {
        if (this.readyState !== RawWebSocket.CLOSED) {
          this.writeFrame(OP_CLOSE, payload.length >= 2 ? payload.subarray(0, 2) : Buffer.alloc(0));
          this.socket?.end();
          this.readyState = RawWebSocket.CLOSED;
          this.emit('close');
        }
        return;
      }

      if (opcode === OP_PING) {
        this.writeFrame(OP_PONG, payload);
        continue;
      }

      if (opcode === OP_PONG) {
        continue;
      }

      // Data frame (text or binary)
      if (fin) {
        this.emit('message', payload);
      } else {
        this.fragments = [payload];
      }
    }
  }

  // ── Frame writing (client must mask) ──────────────────────────────────

  private writeFrame(opcode: number, payload: Buffer): void {
    if (!this.socket || this.socket.destroyed) return;

    const mask = randomBytes(4);
    let header: Buffer;

    if (payload.length < 126) {
      header = Buffer.alloc(6);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | payload.length;
      mask.copy(header, 2);
    } else if (payload.length < 0x10000) {
      header = Buffer.alloc(8);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
      mask.copy(header, 4);
    } else {
      header = Buffer.alloc(14);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(payload.length, 6);
      mask.copy(header, 10);
    }

    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) {
      masked[i] ^= mask[i & 3];
    }

    this.socket.write(Buffer.concat([header, masked]));
  }

  // ── Public API (ws-module compatible) ─────────────────────────────────

  send(data: string | Buffer, cb?: (err?: Error) => void): void {
    try {
      const payload = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
      this.writeFrame(OP_TEXT, payload);
      cb?.();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (cb) cb(error);
      else this.emit('error', error);
    }
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState >= RawWebSocket.CLOSING) return;
    this.readyState = RawWebSocket.CLOSING;

    const reasonBuf = Buffer.from(reason, 'utf-8');
    const payload = Buffer.alloc(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);

    this.writeFrame(OP_CLOSE, payload);
    this.socket?.end();
  }
}
