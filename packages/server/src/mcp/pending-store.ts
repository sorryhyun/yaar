/**
 * PendingStore — typed lifecycle manager for request/response pairs.
 *
 * Encapsulates the create-with-timeout / resolve / clear-for-session
 * pattern used by ActionEmitter's four pending maps.
 */

export class PendingStore<TResult, TMeta = void> {
  private entries = new Map<
    string,
    {
      resolve: (value: TResult) => void;
      timeoutId: NodeJS.Timeout;
      sessionId?: string;
      meta: TMeta;
    }
  >();

  /**
   * Create a pending entry that resolves when `resolve()` is called
   * or falls back to `defaultValue` on timeout.
   */
  create(
    id: string,
    opts: {
      timeoutMs: number;
      sessionId?: string;
      defaultValue: TResult;
    } & (TMeta extends void ? { meta?: undefined } : { meta: TMeta }),
  ): Promise<TResult> {
    return new Promise<TResult>((resolve) => {
      const timeoutId = setTimeout(() => {
        this.entries.delete(id);
        resolve(opts.defaultValue);
      }, opts.timeoutMs);

      this.entries.set(id, {
        resolve,
        timeoutId,
        sessionId: opts.sessionId,
        meta: (opts as { meta?: TMeta }).meta as TMeta,
      });
    });
  }

  /**
   * Resolve a pending entry. Returns whether the entry existed and its metadata.
   */
  resolve(id: string, value: TResult): { resolved: boolean; meta?: TMeta } {
    const entry = this.entries.get(id);
    if (!entry) return { resolved: false };

    clearTimeout(entry.timeoutId);
    this.entries.delete(id);
    entry.resolve(value);
    return { resolved: true, meta: entry.meta };
  }

  /**
   * Force-clear all pending entries for a session, resolving each with `defaultValue`.
   */
  clearForSession(sessionId: string, defaultValue: TResult): void {
    for (const [id, entry] of this.entries) {
      if (entry.sessionId === sessionId) {
        clearTimeout(entry.timeoutId);
        this.entries.delete(id);
        entry.resolve(defaultValue);
      }
    }
  }
}
