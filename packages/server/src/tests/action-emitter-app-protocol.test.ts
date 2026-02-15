/**
 * Tests for ActionEmitter's App Protocol methods:
 * - notifyAppReady / isAppReady
 * - waitForAppReady
 * - emitAppProtocolRequest / resolveAppProtocolResponse
 *
 * Uses a TestableAppProtocolEmitter that reproduces the app protocol
 * methods to avoid AsyncLocalStorage and other server dependencies.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

interface AppProtocolRequest {
  kind: string;
  [key: string]: unknown;
}

interface AppProtocolResponse {
  kind: string;
  [key: string]: unknown;
}

interface PendingAppRequest {
  resolve: (response: AppProtocolResponse | null) => void;
  timeoutId: NodeJS.Timeout;
  sessionId?: string;
}

/**
 * Minimal reproduction of ActionEmitter's app protocol methods.
 * Avoids importing the real ActionEmitter which depends on
 * AsyncLocalStorage, permissions, etc.
 */
class TestableAppProtocolEmitter extends EventEmitter {
  private readyWindows = new Set<string>();
  private pendingAppRequests = new Map<string, PendingAppRequest>();
  private requestCounter = 0;

  private generateRequestId(): string {
    return `req-${Date.now()}-${++this.requestCounter}`;
  }

  notifyAppReady(windowId: string): void {
    this.readyWindows.add(windowId);
    this.emit('app-ready', windowId);
  }

  isAppReady(windowId: string): boolean {
    return this.readyWindows.has(windowId);
  }

  waitForAppReady(windowId: string, timeoutMs: number = 5000): Promise<boolean> {
    if (this.readyWindows.has(windowId)) return Promise.resolve(true);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.off('app-ready', handler);
        resolve(false);
      }, timeoutMs);

      const handler = (readyWindowId: string) => {
        if (readyWindowId === windowId) {
          clearTimeout(timeout);
          this.off('app-ready', handler);
          resolve(true);
        }
      };

      this.on('app-ready', handler);
    });
  }

  async emitAppProtocolRequest(
    windowId: string,
    request: AppProtocolRequest,
    timeoutMs: number = 5000,
  ): Promise<AppProtocolResponse | null> {
    const requestId = this.generateRequestId();

    const responsePromise = new Promise<AppProtocolResponse | null>((resolve) => {
      const timeoutId = setTimeout(() => {
        this.pendingAppRequests.delete(requestId);
        resolve(null);
      }, timeoutMs);

      this.pendingAppRequests.set(requestId, { resolve, timeoutId, sessionId: undefined });
    });

    this.emit('app-protocol', { requestId, windowId, request });

    return responsePromise;
  }

  resolveAppProtocolResponse(requestId: string, response: AppProtocolResponse): boolean {
    const pending = this.pendingAppRequests.get(requestId);
    if (pending) {
      clearTimeout(pending.timeoutId);
      this.pendingAppRequests.delete(requestId);
      pending.resolve(response);
      return true;
    }
    return false;
  }
}

describe('ActionEmitter App Protocol', () => {
  let emitter: TestableAppProtocolEmitter;

  beforeEach(() => {
    emitter = new TestableAppProtocolEmitter();
  });

  // --- notifyAppReady / isAppReady ---

  describe('notifyAppReady / isAppReady', () => {
    it('isAppReady returns false for unknown window', () => {
      expect(emitter.isAppReady('win-unknown')).toBe(false);
    });

    it('isAppReady returns true after notifyAppReady', () => {
      emitter.notifyAppReady('win-1');
      expect(emitter.isAppReady('win-1')).toBe(true);
    });

    it('ready state is independent per window', () => {
      emitter.notifyAppReady('win-1');

      expect(emitter.isAppReady('win-1')).toBe(true);
      expect(emitter.isAppReady('win-2')).toBe(false);

      emitter.notifyAppReady('win-2');
      expect(emitter.isAppReady('win-2')).toBe(true);
    });
  });

  // --- waitForAppReady ---

  describe('waitForAppReady', () => {
    it('resolves immediately with true if already ready', async () => {
      emitter.notifyAppReady('win-1');

      const result = await emitter.waitForAppReady('win-1');
      expect(result).toBe(true);
    });

    it('resolves with true when notifyAppReady is called after waiting', async () => {
      const promise = emitter.waitForAppReady('win-1');

      // Simulate the app becoming ready shortly after
      emitter.notifyAppReady('win-1');

      const result = await promise;
      expect(result).toBe(true);
    });

    it('times out and resolves with false', async () => {
      vi.useFakeTimers();
      try {
        const promise = emitter.waitForAppReady('win-1', 1000);

        vi.advanceTimersByTime(1000);

        const result = await promise;
        expect(result).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('only resolves for the correct windowId', async () => {
      vi.useFakeTimers();
      try {
        const promise = emitter.waitForAppReady('win-1', 2000);

        // Notify a different window - should not resolve win-1's promise
        emitter.notifyAppReady('win-2');

        // win-1 should still be waiting, advance past timeout
        vi.advanceTimersByTime(2000);

        const result = await promise;
        expect(result).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // --- emitAppProtocolRequest / resolveAppProtocolResponse ---

  describe('emitAppProtocolRequest / resolveAppProtocolResponse', () => {
    it('emits app-protocol event with requestId, windowId, and request', async () => {
      const events: any[] = [];
      emitter.on('app-protocol', (data) => events.push(data));

      const request: AppProtocolRequest = { kind: 'manifest' };
      const responsePromise = emitter.emitAppProtocolRequest('win-1', request);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        windowId: 'win-1',
        request: { kind: 'manifest' },
      });
      expect(typeof events[0].requestId).toBe('string');
      expect(events[0].requestId.length).toBeGreaterThan(0);

      // Resolve so the promise settles
      emitter.resolveAppProtocolResponse(events[0].requestId, { kind: 'manifest', manifest: {} });
      await responsePromise;
    });

    it('resolveAppProtocolResponse returns response and true for pending request', async () => {
      const events: any[] = [];
      emitter.on('app-protocol', (data) => events.push(data));

      const request: AppProtocolRequest = { kind: 'query', stateKey: 'count' };
      const responsePromise = emitter.emitAppProtocolRequest('win-1', request);

      const response: AppProtocolResponse = { kind: 'query', data: 42 };
      const resolved = emitter.resolveAppProtocolResponse(events[0].requestId, response);

      expect(resolved).toBe(true);

      const result = await responsePromise;
      expect(result).toEqual({ kind: 'query', data: 42 });
    });

    it('resolveAppProtocolResponse returns false for unknown requestId', () => {
      const result = emitter.resolveAppProtocolResponse('nonexistent-id', { kind: 'manifest' });
      expect(result).toBe(false);
    });

    it('request times out and returns null', async () => {
      vi.useFakeTimers();
      try {
        const request: AppProtocolRequest = { kind: 'command', command: 'doSomething' };
        const responsePromise = emitter.emitAppProtocolRequest('win-1', request, 1000);

        vi.advanceTimersByTime(1000);

        const result = await responsePromise;
        expect(result).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('generates unique requestIds for consecutive requests', async () => {
      const events: any[] = [];
      emitter.on('app-protocol', (data) => events.push(data));

      const p1 = emitter.emitAppProtocolRequest('win-1', { kind: 'manifest' });
      const p2 = emitter.emitAppProtocolRequest('win-1', { kind: 'manifest' });
      const p3 = emitter.emitAppProtocolRequest('win-2', { kind: 'query', stateKey: 'x' });

      expect(events).toHaveLength(3);

      const ids = events.map((e) => e.requestId);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(3);

      // Clean up: resolve all pending requests
      for (const event of events) {
        emitter.resolveAppProtocolResponse(event.requestId, { kind: 'manifest' });
      }
      await Promise.all([p1, p2, p3]);
    });
  });
});
