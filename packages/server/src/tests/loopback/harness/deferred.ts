/**
 * A promise a test resolves by hand.
 *
 * Two jobs here, and they are opposites. A *gate* lets a test park a turn where it wants
 * it — inside a tool step, holding the connection queue open — so the frames that arrive
 * next arrive while the server is genuinely busy, which is the only state in which the
 * ordering questions (S3, S4) mean anything. A *signal* is the reverse: the turn telling
 * the test it has reached the wait, so the test never has to guess with a timer.
 *
 * The guessing is what this replaces. A turn does real work before it reaches its tool —
 * a system prompt to assemble, an app profile to read off disk — so "flush a few turns of
 * the event loop, then assume" races the server rather than observing it. Where the wait
 * announces itself with a frame, `FakeClient.waitForFrame` is the observation; where it
 * does not (`waitForAppReady` sends nothing — the app is expected to speak first), this is.
 */
export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
