import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import { useDesktopStore } from '@/store';
import {
  connect,
  disconnect,
  recoverAfterResume,
  retryConnection,
} from '@/lib/transport/connection';
import { wsManager } from '@/lib/transport/transport-manager';
import { LIVENESS_PROBE_TIMEOUT_MS } from '@/lib/transport/liveness-probe';

const NativeWebSocket = globalThis.WebSocket;

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Array<{ type: string }> = [];
  closeCalls = 0;

  constructor(_url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.closeCalls++;
    this.readyState = FakeSocket.CLOSING;
    // A vanished peer never finishes the close handshake.
  }
}

beforeEach(() => {
  jest.useFakeTimers();
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  FakeSocket.instances = [];
  wsManager.stopped = false;
  useDesktopStore.setState({ windows: {}, outbox: [], activeAgents: {}, formFactor: 'desktop' });
});

afterEach(() => {
  disconnect();
  globalThis.WebSocket = NativeWebSocket;
  jest.useRealTimers();
});

describe('mobile connection recovery', () => {
  it('disconnects during a handshake and ignores its late callbacks', () => {
    connect();
    const old = FakeSocket.instances[0];
    recoverAfterResume();
    disconnect();
    expect(old.closeCalls).toBe(1);
    expect(wsManager.ws).toBeNull();
    expect(wsManager.attached).toBe(false);

    old.readyState = FakeSocket.OPEN;
    old.onopen?.();
    old.onmessage?.({ data: JSON.stringify({ type: 'SESSION_ATTACHED' }) } as MessageEvent);
    old.onclose?.({ code: 1006 } as CloseEvent);
    jest.advanceTimersByTime(LIVENESS_PROBE_TIMEOUT_MS * 2);
    expect(old.sent).toEqual([]);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(useDesktopStore.getState().connectionStatus).toBe('disconnected');
  });

  it.each([FakeSocket.CLOSING, FakeSocket.CLOSED])(
    'replaces a resumed socket in state %s without waiting for onclose',
    (state) => {
      connect();
      const old = FakeSocket.instances[0];
      old.readyState = state;
      recoverAfterResume();
      expect(FakeSocket.instances).toHaveLength(2);
      old.onclose?.({ code: 1006 } as CloseEvent);
      expect(wsManager.ws).toBe(FakeSocket.instances[1] as unknown as WebSocket);
      expect(wsManager.reconnectTimeout).toBeNull();
    },
  );

  it('skips the remaining backoff when the user returns to a disconnected tab', () => {
    connect();
    FakeSocket.instances[0].onclose?.({ code: 1006 } as CloseEvent);
    expect(wsManager.reconnectTimeout).not.toBeNull();
    recoverAfterResume();
    expect(FakeSocket.instances).toHaveLength(2);
    expect(wsManager.reconnectTimeout).toBeNull();
  });

  it('leaves an explicitly disconnected tab offline on resume', () => {
    disconnect();
    recoverAfterResume();
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it('lets manual Retry replace a handshake that is stuck', () => {
    connect();
    const old = FakeSocket.instances[0];
    retryConnection();
    expect(old.closeCalls).toBe(1);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it('does not flush an unattached socket, and keeps probing after transport open', () => {
    connect();
    const old = FakeSocket.instances[0];
    recoverAfterResume();
    old.readyState = FakeSocket.OPEN;
    old.onopen?.();
    recoverAfterResume();
    expect(old.sent.map((frame) => frame.type)).toEqual(['SUBSCRIBE_MONITOR', 'CLIENT_PRESENCE']);
    jest.advanceTimersByTime(LIVENESS_PROBE_TIMEOUT_MS);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it('re-reports the monitor layout on resume, before anything queued goes out', () => {
    // The server keeps viewport and form factor per monitor, not per tab. A socket that
    // survived a freeze never reconnects, so without this the phone never corrects a
    // layout someone else wrote while it was away (#119).
    connect();
    const socket = FakeSocket.instances[0];
    socket.readyState = FakeSocket.OPEN;
    wsManager.attached = true;
    useDesktopStore.setState({ formFactor: 'mobile' });
    recoverAfterResume();
    const first = socket.sent[0] as { type: string; formFactor?: string };
    expect(first.type).toBe('SUBSCRIBE_MONITOR');
    expect(first.formFactor).toBe('mobile');
    expect(socket.sent.map((frame) => frame.type)).toContain('RESYNC');
  });

  it('resyncs an attached socket and cancels replacement when the server answers', () => {
    connect();
    const socket = FakeSocket.instances[0];
    socket.readyState = FakeSocket.OPEN;
    wsManager.attached = true;
    recoverAfterResume();
    expect(socket.sent.some((frame) => frame.type === 'RESYNC')).toBe(true);
    socket.onmessage?.({
      data: JSON.stringify({ type: 'SNAPSHOT', actions: [], agents: [] }),
    } as MessageEvent);
    jest.advanceTimersByTime(LIVENESS_PROBE_TIMEOUT_MS);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});
