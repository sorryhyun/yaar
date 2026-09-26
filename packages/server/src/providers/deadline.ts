/**
 * Resolve `promise`, or reject once `ms` have passed.
 *
 * Deliberately not a "resolve with undefined on timeout": the Claude provider's
 * callers treat a missing answer as a reason to escalate, and `undefined` is
 * already the SDK's spelling for "old CLI, acknowledged with no detail".
 * Collapsing the two would make a hung control channel look like a clean stop.
 *
 * The timer is cleared however `promise` settles. A bare `Promise.race` against
 * a `setTimeout` is the shape this replaced, and it leaves the timer armed after
 * the race is won — one live 10s timer per Codex steer.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    // Cleared in the same tick the answer lands, not a `.finally()` hop later —
    // by then the caller has already resumed with the timer still armed.
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
