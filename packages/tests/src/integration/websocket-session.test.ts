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

  it('registers the connection and sends CONNECTION_STATUS event', async () => {
    const { createWsHandlers } = await import('@yaar/server/websocket/server');

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

    // Should have sent at least the CONNECTION_STATUS event
    expect(ws.sentMessages.length).toBeGreaterThan(0);
    const event = JSON.parse(ws.sentMessages[0]);
    expect(event.type).toBe('CONNECTION_STATUS');
    expect(event.status).toBe('connected');
    expect(event.sessionId).toBeTruthy();
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
