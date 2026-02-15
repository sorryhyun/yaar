import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BroadcastCenter } from '../session/broadcast-center.js';
import type { ServerEvent } from '@yaar/shared';

/** Minimal mock of WebSocket */
function createMockWs(readyState = 1 /* OPEN */) {
  return {
    readyState,
    OPEN: 1,
    send: vi.fn(),
  } as unknown as import('ws').WebSocket;
}

describe('BroadcastCenter', () => {
  let bc: BroadcastCenter;

  beforeEach(() => {
    bc = new BroadcastCenter();
  });

  afterEach(() => {
    bc.clear();
  });

  const testEvent: ServerEvent = { type: 'AGENT_THINKING', content: 'thinking...' };

  describe('connection management', () => {
    it('subscribes and tracks connections', () => {
      bc.subscribe('c1', createMockWs(), 'ses-test');
      expect(bc.getStats().connectionCount).toBe(1);
    });

    it('unsubscribe removes connection', () => {
      bc.subscribe('c1', createMockWs(), 'ses-test');
      bc.unsubscribe('c1');
      expect(bc.getStats().connectionCount).toBe(0);
    });
  });

  describe('publishing', () => {
    it('publishToConnection sends JSON', () => {
      const ws = createMockWs();
      bc.subscribe('c1', ws, 'ses-test');

      const result = bc.publishToConnection(testEvent, 'c1');
      expect(result).toBe(true);
      expect(ws.send).toHaveBeenCalledWith(JSON.stringify(testEvent));
    });

    it('returns false for missing connection', () => {
      expect(bc.publishToConnection(testEvent, 'nonexistent')).toBe(false);
    });

    it('returns false for closed connection', () => {
      bc.subscribe('c1', createMockWs(3 /* CLOSED */), 'ses-test');
      expect(bc.publishToConnection(testEvent, 'c1')).toBe(false);
    });

    it('broadcast sends to all connections', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      bc.subscribe('c1', ws1, 'ses-test');
      bc.subscribe('c2', ws2, 'ses-test');

      const count = bc.broadcast(testEvent);
      expect(count).toBe(2);
      expect(ws1.send).toHaveBeenCalled();
      expect(ws2.send).toHaveBeenCalled();
    });
  });

  it('clear removes everything', () => {
    bc.subscribe('c1', createMockWs(), 'ses-test');
    bc.clear();
    expect(bc.getStats()).toEqual({ connectionCount: 0 });
  });
});
