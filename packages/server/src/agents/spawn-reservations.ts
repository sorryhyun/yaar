/**
 * Creations reserved but not yet landed.
 *
 * Every tier that builds an agent has the same three-step hazard, and `agent-pool.ts`
 * solved it twice — once for app agents, once for sub-agents — in code that had drifted
 * apart in shape while agreeing on every rule. The rules, none of which may change when
 * the copies merge:
 *
 * 1. **Reserve before the first await.** Two creations for one key that overlap inside
 *    `acquireProvider` both find the collection empty; the loser lands in *no collection
 *    at all* — unreachable by every dispose path and by `cleanup()`, while still holding
 *    a provider process and a `MAX_AGENTS` slot until the process dies. The reservation
 *    is written synchronously, so a second caller finds it.
 * 2. **Join, do not restart.** A caller that finds a reservation awaits it and gets the
 *    same agent it would have found had it arrived one tick later.
 * 3. **Settle before you sweep.** A teardown that enumerates a collection walks straight
 *    past a creation still in flight, and the agent lands moments after the thing that
 *    owns it stopped existing. Every dispose path settles the matching reservations
 *    first — see the `settle` calls in `AgentPool`.
 *
 * Reservations also *count*: the app's `subagents.max` is measured against live records
 * plus reservations, so the cap holds under concurrency rather than only at rest.
 *
 * `Tag` is whatever a match needs that the key does not spell out. The sub-agent tier
 * carries `{ monitorId, appId }` rather than parsing them back out of its key, for the
 * same reason `SubAgent` carries them: the key is opaque.
 */
export class SpawnReservations<T, Tag = void> {
  private inFlight = new Map<string, { tag: Tag; pending: Promise<T | null> }>();

  /** A creation already on its way for this key, to join rather than duplicate. */
  get(key: string): Promise<T | null> | undefined {
    return this.inFlight.get(key)?.pending;
  }

  /**
   * Start a creation with its reservation held, and release the reservation once it
   * settles — whichever way it settles.
   *
   * `create` is invoked synchronously and the reservation written before this method
   * yields, which is rule 1. Callers must therefore take every *decision* (does it
   * already exist, is the tier at capacity) before calling, not inside `create`.
   */
  async reserve(key: string, tag: Tag, create: () => Promise<T | null>): Promise<T | null> {
    const pending = create();
    this.inFlight.set(key, { tag, pending });
    try {
      return await pending;
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** How many reservations match — the concurrency half of a capacity check. */
  count(match: (tag: Tag, key: string) => boolean): number {
    let n = 0;
    for (const [key, entry] of this.inFlight) {
      if (match(entry.tag, key)) n++;
    }
    return n;
  }

  /**
   * Wait out the reservations a teardown is about to sweep past (rule 3).
   *
   * `allSettled`, because a spawn that failed has nothing left to sweep and must not
   * stop the sweep from happening.
   */
  async settle(match: (tag: Tag, key: string) => boolean): Promise<void> {
    const pending: Promise<T | null>[] = [];
    for (const [key, entry] of this.inFlight) {
      if (match(entry.tag, key)) pending.push(entry.pending);
    }
    if (pending.length > 0) await Promise.allSettled(pending);
  }
}
