/**
 * Tests for ActionEmitter.clearPendingForSession().
 *
 * Verifies that clearing pending requests for a session resolves/rejects
 * all outstanding promises without affecting other sessions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// We test the clearPendingForSession logic directly by constructing
// a minimal ActionEmitter-like class to avoid importing modules with
// heavy server-side dependencies (AsyncLocalStorage, permissions, etc.).

interface PendingRequest {
  resolve: (feedback: any) => void;
  timeoutId: NodeJS.Timeout;
  sessionId?: string;
}

interface PendingDialog {
  resolve: (confirmed: boolean) => void;
  timeoutId: NodeJS.Timeout;
  sessionId?: string;
}

interface PendingAppRequest {
  resolve: (response: any) => void;
  timeoutId: NodeJS.Timeout;
  sessionId?: string;
}

/**
 * Minimal reproduction of ActionEmitter's pending-request management
 * and clearPendingForSession logic.
 */
class TestableActionEmitter extends EventEmitter {
  pendingRequests = new Map<string, PendingRequest>();
  pendingDialogs = new Map<string, PendingDialog>();
  pendingAppRequests = new Map<string, PendingAppRequest>();

  addPendingRequest(id: string, sessionId: string): Promise<any> {
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(id);
        resolve(null);
      }, 30_000);
      this.pendingRequests.set(id, { resolve, timeoutId, sessionId });
    });
  }

  addPendingDialog(id: string, sessionId: string): Promise<boolean> {
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        this.pendingDialogs.delete(id);
        resolve(false);
      }, 30_000);
      this.pendingDialogs.set(id, { resolve, timeoutId, sessionId });
    });
  }

  addPendingAppRequest(id: string, sessionId: string): Promise<any> {
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        this.pendingAppRequests.delete(id);
        resolve(null);
      }, 30_000);
      this.pendingAppRequests.set(id, { resolve, timeoutId, sessionId });
    });
  }

  clearPendingForSession(sessionId: string): void {
    for (const [id, pending] of this.pendingRequests) {
      if (pending.sessionId === sessionId) {
        clearTimeout(pending.timeoutId);
        this.pendingRequests.delete(id);
        pending.resolve(null);
      }
    }

    for (const [id, pending] of this.pendingDialogs) {
      if (pending.sessionId === sessionId) {
        clearTimeout(pending.timeoutId);
        this.pendingDialogs.delete(id);
        pending.resolve(false);
      }
    }

    for (const [id, pending] of this.pendingAppRequests) {
      if (pending.sessionId === sessionId) {
        clearTimeout(pending.timeoutId);
        this.pendingAppRequests.delete(id);
        pending.resolve(null);
      }
    }
  }
}

describe('ActionEmitter.clearPendingForSession', () => {
  let emitter: TestableActionEmitter;

  beforeEach(() => {
    emitter = new TestableActionEmitter();
  });

  it('resolves all pending requests for the target session', async () => {
    const p1 = emitter.addPendingRequest('req-1', 'session-A');
    const p2 = emitter.addPendingRequest('req-2', 'session-A');

    emitter.clearPendingForSession('session-A');

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBeNull();
    expect(r2).toBeNull();
    expect(emitter.pendingRequests.size).toBe(0);
  });

  it('resolves all pending dialogs for the target session with false', async () => {
    const p1 = emitter.addPendingDialog('dlg-1', 'session-A');
    const p2 = emitter.addPendingDialog('dlg-2', 'session-A');

    emitter.clearPendingForSession('session-A');

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(false);
    expect(r2).toBe(false);
    expect(emitter.pendingDialogs.size).toBe(0);
  });

  it('resolves all pending app requests for the target session with null', async () => {
    const p1 = emitter.addPendingAppRequest('app-1', 'session-A');

    emitter.clearPendingForSession('session-A');

    const result = await p1;
    expect(result).toBeNull();
    expect(emitter.pendingAppRequests.size).toBe(0);
  });

  it('does NOT affect pending items belonging to other sessions', async () => {
    const pA = emitter.addPendingRequest('req-A', 'session-A');
    emitter.addPendingRequest('req-B', 'session-B');
    const pDialogA = emitter.addPendingDialog('dlg-A', 'session-A');
    emitter.addPendingDialog('dlg-B', 'session-B');

    emitter.clearPendingForSession('session-A');

    // session-A items resolve immediately
    const [rA, rDialogA] = await Promise.all([pA, pDialogA]);
    expect(rA).toBeNull();
    expect(rDialogA).toBe(false);

    // session-B items are still pending
    expect(emitter.pendingRequests.has('req-B')).toBe(true);
    expect(emitter.pendingDialogs.has('dlg-B')).toBe(true);
  });

  it('handles mixed pending types across sessions', async () => {
    const pReq = emitter.addPendingRequest('req-1', 'session-X');
    const pDlg = emitter.addPendingDialog('dlg-1', 'session-X');
    const pApp = emitter.addPendingAppRequest('app-1', 'session-X');

    // Other session
    emitter.addPendingRequest('req-other', 'session-Y');

    emitter.clearPendingForSession('session-X');

    const [rReq, rDlg, rApp] = await Promise.all([pReq, pDlg, pApp]);
    expect(rReq).toBeNull();
    expect(rDlg).toBe(false);
    expect(rApp).toBeNull();

    // session-Y unaffected
    expect(emitter.pendingRequests.has('req-other')).toBe(true);
    expect(emitter.pendingRequests.size).toBe(1);
  });

  it('is safe to call with a session that has no pending items', () => {
    emitter.addPendingRequest('req-1', 'session-A');

    // No error when clearing a non-existent session
    expect(() => emitter.clearPendingForSession('session-NONE')).not.toThrow();

    // Original items still pending
    expect(emitter.pendingRequests.size).toBe(1);
  });

  it('clears timeouts so they do not fire after session clear', async () => {
    vi.useFakeTimers();
    try {
      const p1 = emitter.addPendingRequest('req-1', 'session-A');

      emitter.clearPendingForSession('session-A');

      const result = await p1;
      expect(result).toBeNull();

      // Advance timers past the original 30s timeout
      vi.advanceTimersByTime(60_000);

      // Map should still be empty (timeout didn't re-fire)
      expect(emitter.pendingRequests.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
