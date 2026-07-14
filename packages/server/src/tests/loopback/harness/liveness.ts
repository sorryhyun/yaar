/**
 * Assertions about *whether a promise finishes*, which is the class of question every
 * test we owned was unable to ask.
 *
 * ~460 tests, all of the form "given this input, expect this output". A deadlock produces
 * an output — the timeout message — so it slips through every one of them looking like a
 * slow app. What none of them said was "this must finish", "this must finish *while that
 * one is still running*", or "this must not have finished yet". Those three shapes are
 * here.
 *
 * There is no fake clock: Bun can move `Date`, not `setTimeout`, and every wait in the
 * server (`PendingStore`, `waitForAppReady`, dialog expiry) is a real timer. So the
 * deadlines move instead — see `setDeadlinesForTest` in config.ts — and these race against
 * real wall clock at tens of milliseconds. A deadlocked turn fails in a quarter of a
 * second; nothing here can hang CI.
 *
 * The rule that goes with them: **no harness test awaits a possibly-deadlocked promise
 * bare.** Every await of a turn or a wait goes through `expectSettlesWithin`, with a
 * budget. An await without one is a test that hangs instead of failing.
 */

/** A promise, and whether it has settled — without consuming it. */
function track<T>(promise: Promise<T>): { promise: Promise<T>; settled: () => boolean } {
  let done = false;
  const tracked = promise.then(
    (v) => {
      done = true;
      return v;
    },
    (e) => {
      done = true;
      throw e;
    },
  );
  // The caller decides whether to await; an unhandled rejection here would be reported
  // against the test rather than against the assertion that is about to make it.
  tracked.catch(() => {});
  return { promise: tracked, settled: () => done };
}

/** Let every microtask and one macrotask turn run, so "pending" means pending, not "not yet scheduled". */
export async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

/**
 * The promise must finish inside the budget. Failure names the budget, because the number
 * is the finding: a turn that needed 30s to end is a turn that ended at *its deadline*,
 * which is the deadlock's signature, not the app's latency.
 */
export async function expectSettlesWithin<T>(
  promise: Promise<T>,
  budgetMs: number,
  what = 'promise',
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `${what} did not settle within ${budgetMs}ms. It is waiting on something that ` +
              `cannot arrive while it waits — check that the answering frame overtakes the ` +
              `connection queue (ANSWER_EVENT_TYPES).`,
          ),
        ),
      budgetMs,
    );
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The promise must NOT have finished yet — the wait we claim to be holding is real, and
 * the ordering we claim to enforce is enforced. Without this, "it settled" proves nothing:
 * a wait that was never entered also settles.
 *
 * Returns nothing, deliberately. Handing the promise back would be the natural shape, and
 * it is a trap: an `async` function *awaits* a promise it returns, so a helper whose whole
 * job is "do not wait for this" would wait for it — silently, and for exactly as long as
 * the deadlock it was hired to detect. Keep using the promise you passed in.
 */
export async function expectStillPending(
  promise: Promise<unknown>,
  what = 'promise',
): Promise<void> {
  const { settled } = track(promise);
  await flush();
  if (settled()) {
    throw new Error(`${what} already settled — it was expected to still be waiting.`);
  }
}

/**
 * `probe` must settle while `blocked` is still in flight — the server serves one thing
 * while another waits, rather than serializing the two. This is the shape that says a
 * queue is a queue and not a chokepoint.
 */
export async function expectConcurrent<B>(
  blocked: Promise<unknown>,
  probe: Promise<B>,
  budgetMs: number,
  what = 'probe',
): Promise<B> {
  const { settled: blockedSettled } = track(blocked);
  const value = await expectSettlesWithin(probe, budgetMs, what);
  if (blockedSettled()) {
    throw new Error(
      `${what} settled, but only after the promise it was supposed to overtake had ` +
        `already finished — concurrency was not demonstrated.`,
    );
  }
  return value;
}
