/**
 * PendingStore — typed lifecycle manager for request/response pairs.
 *
 * Encapsulates the create-with-deadline / resolve / clear-for-session pattern used by
 * ActionEmitter's four pending maps.
 *
 * **A deadline that passes is not an answer.** This store used to resolve an expired
 * entry with a caller-supplied `defaultValue`, which made "the frontend said nothing"
 * indistinguishable from "the frontend said this". The rendering-feedback map defaulted
 * to `null`, and its call site read `if (feedback && !feedback.success)` — so a window
 * whose iframe never reported back was announced to the agent as rendered. Every caller
 * inherited the same shape: a timeout was whatever value looked innocuous at the call
 * site, and none of them could tell that it *was* a timeout.
 *
 * So there is no default. An entry resolves to an outcome that names which of the three
 * things happened, and a caller must say — in code, at the call site — what a missed
 * deadline means for it. For some (a lock veto that never came) it means "proceed"; for
 * others (a window that never rendered) it means "do not claim this worked". That is a
 * judgement only the call site can make, and now it has to.
 */

/**
 * How a pending entry ended.
 *
 * - `ok: true` — a real answer arrived.
 * - `timeout` — the deadline passed with no answer.
 * - `cancelled` — the session went away first (`clearForSession`).
 */
export type PendingOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'timeout' | 'cancelled' };

/** The value of a settled entry, or `undefined` if it timed out or was cancelled. */
export function valueOf<T>(outcome: PendingOutcome<T>): T | undefined {
  return outcome.ok ? outcome.value : undefined;
}

export class PendingStore<TResult, TMeta = void> {
  private entries = new Map<
    string,
    {
      settle: (outcome: PendingOutcome<TResult>) => void;
      timeoutId: NodeJS.Timeout;
      sessionId?: string;
      meta: TMeta;
    }
  >();

  /**
   * Create a pending entry that settles when `resolve()` is called, or on expiry.
   *
   * `onExpire` runs on the timeout path only, before the promise settles. It exists
   * because the thing waiting is not the only party that needs to know the wait is
   * over: a dialog the server has stopped listening to must also leave the user's
   * screen, or they will answer a question nobody is asking any more.
   */
  create(
    id: string,
    opts: {
      timeoutMs: number;
      sessionId?: string;
      onExpire?: (id: string, meta: TMeta) => void;
    } & (TMeta extends void ? { meta?: undefined } : { meta: TMeta }),
  ): Promise<PendingOutcome<TResult>> {
    const meta = (opts as { meta?: TMeta }).meta as TMeta;

    return new Promise<PendingOutcome<TResult>>((settle) => {
      const timeoutId = setTimeout(() => {
        this.entries.delete(id);
        opts.onExpire?.(id, meta);
        settle({ ok: false, reason: 'timeout' });
      }, opts.timeoutMs);

      this.entries.set(id, { settle, timeoutId, sessionId: opts.sessionId, meta });
    });
  }

  /**
   * Resolve a pending entry. Returns whether the entry existed and its metadata.
   *
   * `resolved: false` means the answer arrived for an id this store no longer holds —
   * an expired dialog the user clicked anyway, most often. It is the caller's business
   * to decide what a late answer is worth; the store only reports that it was late.
   */
  resolve(id: string, value: TResult): { resolved: boolean; meta?: TMeta } {
    const entry = this.entries.get(id);
    if (!entry) return { resolved: false };

    clearTimeout(entry.timeoutId);
    this.entries.delete(id);
    entry.settle({ ok: true, value });
    return { resolved: true, meta: entry.meta };
  }

  /**
   * Force-clear every pending entry belonging to a session, settling each as `cancelled`
   * so an awaiting tool unblocks now rather than at its own deadline.
   */
  clearForSession(sessionId: string): void {
    for (const [id, entry] of this.entries) {
      if (entry.sessionId === sessionId) {
        clearTimeout(entry.timeoutId);
        this.entries.delete(id);
        entry.settle({ ok: false, reason: 'cancelled' });
      }
    }
  }
}
