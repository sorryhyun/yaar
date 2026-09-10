/**
 * The send budget in `BroadcastCenter.deliver()`.
 *
 * Server→client events are OS Actions, so the hub never drops one on a connection it keeps
 * open — a client missing a `window.create` renders a desktop that silently disagrees with
 * the session. A connection that has stopped draining is closed instead, because a close is
 * recoverable: the frontend reconnects on any code but 1000 and re-syncs from the session
 * snapshot. These tests pin that choice, both halves of it.
 *
 * One case here is load-bearing beyond the policy: Bun's `ServerWebSocket` — the concrete
 * type this server's connections are — reports its queue through the **method**
 * `getBufferedAmount()` and has no `bufferedAmount` property. A budget that reads the
 * property is therefore `undefined` on every real connection and silently never fires, which
 * is exactly how this was first written. `FakeSocket` deliberately mimics Bun and exposes
 * only the method, so that mistake fails here instead of shipping.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import type { ServerEvent } from '@yaar/shared';

import { BroadcastCenter } from '../session/broadcast-center.js';
import { WS_OPEN, type SessionId, type YaarWebSocket } from '../session/types.js';

const LIMIT = 8 * 1024 * 1024;
const SESSION = 'sess-bp' as SessionId;

/**
 * Shaped like Bun's `ServerWebSocket`: the queue depth is a **method**, and there is no
 * `bufferedAmount` property — see the file header for why that detail is the point.
 */
class FakeSocket implements YaarWebSocket {
  readyState = WS_OPEN;
  buffered = 0;
  sent: string[] = [];
  closes: Array<{ code?: number; reason?: string }> = [];

  getBufferedAmount(): number {
    return this.buffered;
  }
  send(data: string | ArrayBufferLike | Uint8Array): void {
    this.sent.push(String(data));
  }
  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    this.readyState = 3; // CLOSED
  }
}

/** Shaped like `ws.WebSocket` / a client socket: the queue depth is a property. */
class PropertyFakeSocket implements YaarWebSocket {
  readyState = WS_OPEN;
  bufferedAmount = 0;
  sent: string[] = [];
  closes: Array<{ code?: number; reason?: string }> = [];

  send(data: string | ArrayBufferLike | Uint8Array): void {
    this.sent.push(String(data));
  }
  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    this.readyState = 3; // CLOSED
  }
}

/** A socket with the *minimum* interface — no `bufferedAmount`, no `close`. */
class MinimalSocket implements YaarWebSocket {
  readyState = WS_OPEN;
  sent: string[] = [];
  send(data: string | ArrayBufferLike | Uint8Array): void {
    this.sent.push(String(data));
  }
}

const event = { type: 'test-event' } as unknown as ServerEvent;

let bc: BroadcastCenter;
beforeEach(() => {
  bc = new BroadcastCenter();
});

describe('BroadcastCenter send budget', () => {
  it('delivers normally while the connection is draining', () => {
    const ws = new FakeSocket();
    ws.buffered = 1024;
    bc.subscribe('c1', ws, SESSION);

    expect(bc.publishToSession(SESSION, event)).toBe(1);
    expect(ws.sent).toHaveLength(1);
    expect(ws.closes).toHaveLength(0);
  });

  it('delivers right up to the limit without closing', () => {
    const ws = new FakeSocket();
    ws.buffered = LIMIT; // at the mark, not over it
    bc.subscribe('c1', ws, SESSION);

    expect(bc.publishToSession(SESSION, event)).toBe(1);
    expect(ws.closes).toHaveLength(0);
  });

  it('closes with 1013 instead of queueing once past the limit', () => {
    const ws = new FakeSocket();
    ws.buffered = LIMIT + 1;
    bc.subscribe('c1', ws, SESSION);

    expect(bc.publishToSession(SESSION, event)).toBe(0);
    // The event was not queued onto a socket that had stopped reading...
    expect(ws.sent).toHaveLength(0);
    // ...and the close code is one the frontend reconnects on (anything but 1000).
    expect(ws.closes).toEqual([{ code: 1013, reason: 'send buffer exceeded' }]);
  });

  it('closes once, however many events arrive after it fell behind', () => {
    const ws = new FakeSocket();
    ws.buffered = LIMIT + 1;
    bc.subscribe('c1', ws, SESSION);

    for (let i = 0; i < 5; i++) bc.publishToSession(SESSION, event);

    expect(ws.closes).toHaveLength(1);
    expect(ws.sent).toHaveLength(0);
  });

  it('keeps serving a healthy connection when a sibling in the session falls behind', () => {
    const slow = new FakeSocket();
    slow.buffered = LIMIT + 1;
    const healthy = new FakeSocket();
    bc.subscribe('slow', slow, SESSION);
    bc.subscribe('healthy', healthy, SESSION);

    // One of two delivered — the overflow must not abort the fan-out.
    expect(bc.publishToSession(SESSION, event)).toBe(1);
    expect(healthy.sent).toHaveLength(1);
    expect(slow.closes).toHaveLength(1);
  });

  it('never withholds from a socket that does not report bufferedAmount', () => {
    // The field is optional on YaarWebSocket; absent must mean "no opinion", not "over".
    const ws = new MinimalSocket();
    bc.subscribe('c1', ws, SESSION);

    expect(bc.publishToSession(SESSION, event)).toBe(1);
    expect(ws.sent).toHaveLength(1);
  });

  it('reads the budget off the property spelling too', () => {
    // A `ws`-shaped socket must be governed by the same budget as a Bun-shaped one.
    const ws = new PropertyFakeSocket();
    ws.bufferedAmount = LIMIT + 1;
    bc.subscribe('c1', ws, SESSION);

    expect(bc.publishToSession(SESSION, event)).toBe(0);
    expect(ws.sent).toHaveLength(0);
    expect(ws.closes).toEqual([{ code: 1013, reason: 'send buffer exceeded' }]);
  });

  it('applies the budget to the single-connection path too', () => {
    const ws = new FakeSocket();
    ws.buffered = LIMIT + 1;
    bc.subscribe('c1', ws, SESSION);

    expect(bc.publishToConnection(event, 'c1')).toBe(false);
    expect(ws.closes).toHaveLength(1);
  });

  it('applies the budget to broadcast() and publishToMonitor()', () => {
    const a = new FakeSocket();
    a.buffered = LIMIT + 1;
    bc.subscribe('a', a, SESSION);
    bc.subscribeToMonitor('a', 'm0');
    expect(bc.publishToMonitor(SESSION, 'm0', event)).toBe(0);

    const b = new FakeSocket();
    b.buffered = LIMIT + 1;
    bc.subscribe('b', b, SESSION);
    expect(bc.broadcast(event)).toBe(0);
    expect(b.closes).toHaveLength(1);
  });
});
