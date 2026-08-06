/**
 * Which iframes have registered with the App Protocol — per session, per window key.
 *
 * The window key ("0/ai-chat") names a window on a monitor, and *every* session has a
 * monitor 0. Keyed by that alone (as this once was) the set is a claim about the process,
 * not about anyone's browser: the first session to open an app made that key ready
 * forever, so the next session's `wait()` returned true for an iframe that had never
 * spoken, `requireAppReady` stopped being a wait, and the first command went out to an
 * iframe not yet listening — reaching the agent as "App did not respond".
 *
 * So the session is in the key, and the whole entry is dropped when the session goes
 * (`forgetSession`) or the window closes (`forget`). Nothing ever left the old set,
 * either: a desktop open for a day accumulated one entry per window it had ever shown.
 *
 * **This is not `WindowState.appProtocol`.** That flag says an iframe *has ever*
 * registered on this window — it is durable window metadata, used to decide whether a
 * window is app-protocol-capable at all. This registry says an iframe is registered
 * *right now*: it is cleared on window close and on session teardown, because a document
 * that has gone away cannot answer a command. A caller asking "may I speak to this app"
 * wants this one; a caller asking "is this window an app" wants the flag.
 *
 * Lifted out of `ActionEmitter` because it is per-(session, window) state with its own
 * waiters, and nothing about it is an emitter concern.
 */

import { deadlines } from '../config.js';

/** One parked `wait()`, resolved by a matching `notify()` or by its own deadline. */
interface ReadyWaiter {
  sessionId: string | undefined;
  windowId: string;
  settle: (ready: boolean) => void;
}

export class AppReadyRegistry {
  private ready = new Map<string, Set<string>>();
  /**
   * Waiters held here rather than as listeners on the emitter's `'app-ready'` channel.
   * That channel is the public announcement — anything may subscribe to it — and a wait
   * that is *also* one of its subscribers makes the registry's own correctness depend on
   * a subscription some other module could remove.
   */
  private waiters = new Set<ReadyWaiter>();

  /**
   * An iframe app in `sessionId` has registered with the App Protocol. Resolves every
   * pending `wait()` for that session's window.
   */
  notify(sessionId: string, windowId: string): void {
    let windows = this.ready.get(sessionId);
    if (!windows) {
      windows = new Set();
      this.ready.set(sessionId, windows);
    }
    windows.add(windowId);

    for (const waiter of [...this.waiters]) {
      if (waiter.sessionId === sessionId && waiter.windowId === windowId) {
        this.waiters.delete(waiter);
        waiter.settle(true);
      }
    }
  }

  /** Whether an app has already signaled readiness *in this session*. */
  isReady(sessionId: string, windowId: string): boolean {
    return this.ready.get(sessionId)?.has(windowId) ?? false;
  }

  /**
   * Forget one window's registration — it closed.
   *
   * A window key is reused: close "ai-chat" and open it again and the key is the same,
   * but the iframe behind it is a new document that has not registered. A registration
   * that outlived its window would tell the next one's first command that the app is
   * already listening. This is the same defect as the cross-session one, at a smaller
   * radius.
   */
  forget(sessionId: string, windowId: string): void {
    const windows = this.ready.get(sessionId);
    if (!windows) return;
    windows.delete(windowId);
    if (windows.size === 0) this.ready.delete(sessionId);
  }

  /**
   * Forget every registration in a session — the browser holding those iframes is gone.
   *
   * Left behind, they would answer the next session's `wait()` on behalf of documents
   * that no longer exist.
   */
  forgetSession(sessionId: string): void {
    this.ready.delete(sessionId);
  }

  /**
   * Wait for an iframe app to register with the App Protocol, in the caller's session.
   * Resolves true if that session's app is already ready or becomes ready within the
   * timeout.
   *
   * `sessionId` is required and not defaulted: a wait that cannot name whose iframe it is
   * waiting for is the bug. An undefined session matches no registration (they all carry
   * one), so it waits out its deadline rather than borrowing another session's answer —
   * but it is also unreachable in practice, since the window registry the caller checked
   * before waiting was itself resolved from a session.
   */
  wait(sessionId: string | undefined, windowId: string, timeoutMs?: number): Promise<boolean> {
    if (sessionId !== undefined && this.isReady(sessionId, windowId)) {
      return Promise.resolve(true);
    }

    return new Promise<boolean>((resolve) => {
      const waiter: ReadyWaiter = {
        sessionId,
        windowId,
        settle: (ready) => {
          clearTimeout(timer);
          resolve(ready);
        },
      };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        resolve(false);
      }, timeoutMs ?? deadlines.appReadyMs);
      this.waiters.add(waiter);
    });
  }
}
