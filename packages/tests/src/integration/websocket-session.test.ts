/**
 * Integration tests: WebSocket session lifecycle.
 *
 * Tests the join protocol, session creation, and reconnection behavior
 * by driving createWsHandlers() / prepareWsData() directly — no network
 * connection required.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { createMockWs } from '../helpers/mocks.js';

// Mock warm pool to prevent AI provider initialization
mock.module('@yaar/server/providers/warm-pool', () => ({
  getWarmPool: mock(() => ({
    getPreferredProvider: () => null,
    acquire: mock(() => null),
    stats: () => ({ warm: 0, pending: 0, total: 0 }),
  })),
  initWarmPool: mock(() => Promise.resolve(true)),
  acquireWarmProvider: mock(() => Promise.resolve(null)),
}));

const { prepareWsData } = await import('@yaar/server/websocket/server');
const { initSessionHub, getSessionHub } = await import('@yaar/server/session/session-hub');

// ── prepareWsData ──────────────────────────────────────────────────────────

describe('prepareWsData', () => {
  it('returns authorized=true with generated connectionId in local mode', () => {
    const url = new URL('ws://localhost:8000/ws');
    const result = prepareWsData(url);
    expect(result.authorized).toBe(true);
    expect(result.data.connectionId).toBeTruthy();
    expect(result.data.sessionId).toBeNull();
    expect(result.data.monitorId).toBeNull();
  });

  it('extracts sessionId from query params', () => {
    const url = new URL('ws://localhost:8000/ws?sessionId=test-session-123');
    const result = prepareWsData(url);
    expect(result.authorized).toBe(true);
    expect(result.data.sessionId).toBe('test-session-123');
  });

  it('extracts monitorId from query params', () => {
    const url = new URL('ws://localhost:8000/ws?monitorId=monitor-1');
    const result = prepareWsData(url);
    expect(result.authorized).toBe(true);
    expect(result.data.monitorId).toBe('monitor-1');
  });

  it('generates unique connectionIds for each call', () => {
    const url = new URL('ws://localhost:8000/ws');
    const r1 = prepareWsData(url);
    const r2 = prepareWsData(url);
    expect(r1.data.connectionId).not.toBe(r2.data.connectionId);
  });
});

// ── SessionHub lifecycle ───────────────────────────────────────────────────

describe('SessionHub session lifecycle', () => {
  let hub: ReturnType<typeof initSessionHub>;

  beforeEach(() => {
    // Fresh hub for each test
    hub = initSessionHub();
  });

  it('creates a new session when none exists', () => {
    const session = hub.getOrCreate(null, {});
    expect(session).toBeDefined();
    expect(session.sessionId).toBeTruthy();
  });

  it('returns the same session on reconnect with matching sessionId', () => {
    const first = hub.getOrCreate(null, {});
    const sessionId = first.sessionId;

    // Simulate reconnect with the same sessionId
    const second = hub.getOrCreate(sessionId, {});
    expect(second.sessionId).toBe(sessionId);
    expect(second).toBe(first); // exact same object
  });

  it('session survives simulated disconnect (hub still has it)', () => {
    const session = hub.getOrCreate(null, {});
    const id = session.sessionId;

    // Simulate disconnect: remove connection but do NOT remove from hub
    session.removeConnection('conn-1');

    // Hub still has the session
    expect(hub.get(id)).toBe(session);
  });

  it('removes a session from the hub even when cleanup() throws', async () => {
    const session = hub.getOrCreate('wedged-session', {});
    hub.registerAgent('agent-1', 'wedged-session');
    session.cleanup = () => Promise.reject(new Error('cleanup exploded'));

    // The failure still surfaces to the caller...
    await expect(hub.remove('wedged-session')).rejects.toThrow('cleanup exploded');

    // ...but a half-torn-down session must not stay resolvable by id.
    expect(hub.get('wedged-session')).toBeUndefined();
    expect(hub.findSessionByAgent('agent-1')).toBeUndefined();

    // A reconnect on the same id gets a fresh session, not the broken one.
    const fresh = hub.getOrCreate('wedged-session', {});
    expect(fresh).not.toBe(session);
  });

  it('tells a rejoin apart from a replacement wearing the same id', async () => {
    const original = hub.getOrCreate(null, {});
    const id = original.sessionId;

    // Reconnect while the session is still live: same incarnation, same epoch.
    const rejoin = hub.attach(id, {});
    expect(rejoin.recoveryMode).toBe('attached');
    expect(rejoin.session).toBe(original);
    expect(rejoin.session.epoch).toBe(original.epoch);

    // The session is evicted, then the client comes back on the same id.
    await hub.remove(id);
    const replaced = hub.attach(id, {});
    expect(replaced.recoveryMode).toBe('replaced');
    expect(replaced.session).not.toBe(original);
    expect(replaced.session.sessionId).toBe(id);
    // Same name, different session — only the epoch says so.
    expect(replaced.session.epoch).toBeGreaterThan(original.epoch);
  });

  it('reports a session seeded from boot state as restored, not attached', () => {
    const restored = hub.attach('from-disk', {
      restoreActions: [
        {
          type: 'window.create',
          windowId: 'w1',
          title: 'Notes',
          bounds: { x: 0, y: 0, w: 400, h: 300 },
          content: { renderer: 'text', data: '' },
        },
      ],
    });
    expect(restored.recoveryMode).toBe('restored');

    // Boot state is seeded into whatever session comes up next, so a session we know we
    // evicted stays a replacement even when windows come back with it.
    const fresh = hub.getOrCreate(null, {});
    expect(hub.attach(fresh.sessionId, {}).recoveryMode).toBe('attached');
  });

  it('reports a connection that asked for nothing as a fresh session', () => {
    expect(hub.attach(null, {}).recoveryMode).toBe('created');
    // A second tab with no session id lands on the default session — that is a rejoin.
    expect(hub.attach(null, {}).recoveryMode).toBe('attached');
  });

  it('getDefault() returns the first created session', () => {
    const s1 = hub.getOrCreate(null, {});
    hub.getOrCreate(null, {}); // second call returns same session (already has default)
    expect(hub.getDefault()).toBe(s1);
  });
});

// ── WebSocket open handler ─────────────────────────────────────────────────

describe('createWsHandlers open()', () => {
  beforeEach(() => {
    initSessionHub();
  });

  it('answers the join with the session incarnation it bound the socket to', async () => {
    const { createWsHandlers } = await import('@yaar/server/websocket/server');
    const hub = getSessionHub();

    const handlers = createWsHandlers({
      restoreActions: [],
      contextMessages: [],
    });

    const ws = createMockWs();
    // Set up ws.data as the handler expects
    (
      ws as never as {
        data: { connectionId: string; sessionId: string | null; monitorId: string | null };
      }
    ).data = {
      connectionId: 'conn-test-1',
      sessionId: null,
      monitorId: null,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handlers.open(ws as any);

    // The handshake is the first thing on the wire — the client needs the session id
    // before any window snapshot lands, and it is what puts the UI into "connected".
    expect(ws.sentMessages.length).toBeGreaterThan(0);
    const event = JSON.parse(ws.sentMessages[0]);
    expect(event.type).toBe('SESSION_ATTACHED');
    expect(event.recoveryMode).toBe('created');
    expect(event.connectionId).toBe('conn-test-1');
    expect(event.sessionId).toBeTruthy();
    expect(event.sessionEpoch).toBe(hub.get(event.sessionId)!.epoch);
  });

  it('marks a reconnect after eviction as a replacement', async () => {
    const { createWsHandlers } = await import('@yaar/server/websocket/server');
    const hub = getSessionHub();
    const handlers = createWsHandlers({ restoreActions: [], contextMessages: [] });

    const evicted = hub.getOrCreate('gone-session', {});
    const oldEpoch = evicted.epoch;
    await hub.remove('gone-session');

    const ws = createMockWs();
    (
      ws as never as {
        data: { connectionId: string; sessionId: string | null; monitorId: string | null };
      }
    ).data = { connectionId: 'conn-test-3', sessionId: 'gone-session', monitorId: null };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handlers.open(ws as any);

    const event = JSON.parse(ws.sentMessages[0]);
    expect(event.type).toBe('SESSION_ATTACHED');
    expect(event.sessionId).toBe('gone-session');
    expect(event.recoveryMode).toBe('replaced');
    expect(event.sessionEpoch).toBeGreaterThan(oldEpoch);
  });

  it('session exists in hub after open()', async () => {
    const hub = getSessionHub();
    const { createWsHandlers } = await import('@yaar/server/websocket/server');

    const handlers = createWsHandlers({
      restoreActions: [],
      contextMessages: [],
    });

    const ws = createMockWs();
    (
      ws as never as {
        data: { connectionId: string; sessionId: string | null; monitorId: string | null };
      }
    ).data = {
      connectionId: 'conn-test-2',
      sessionId: null,
      monitorId: null,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handlers.open(ws as any);

    // Session should now exist in hub
    expect(hub.getDefault()).toBeDefined();
  });
});
