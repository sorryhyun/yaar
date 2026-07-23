/**
 * Deadlines — one budget, and every inner deadline derived from it.
 *
 * A tool call that waits on the user or on an app holds an HTTP request open the whole
 * time it waits, and the transport has a deadline of its own: Bun closes a connection
 * idle for longer than `idleTimeout`, whose maximum is 255s. Deadlines were previously
 * chosen per call site, and two of them (a user prompt, an external MCP call) sat at
 * 300s — *past* the transport's. The connection died 45s before the inner timer fired,
 * so the result was written to a socket nobody was reading, and the timer kept ticking
 * against a request that no longer existed. An inner deadline that outlives its
 * transport cannot report anything, not even its own expiry.
 *
 * So: the transport bound is the outer one, and every deadline that holds a request
 * open fits strictly inside it, leaving room to serialize and flush the answer.
 *
 * This module owns the *only* mutable `deadlines` object in the server. `config.ts`
 * re-exports the same binding; nothing may copy it, or `setDeadlinesForTest()` would
 * shrink one copy and leave call sites reading another.
 */

/** `Bun.serve`'s idle timeout, in seconds. 255 is the protocol maximum — a ceiling, not a choice. */
export const TRANSPORT_IDLE_TIMEOUT_S = 255;

/**
 * The longest a server-side deadline may hold an inbound request open.
 * Strictly below the transport bound, so expiry always reaches the caller.
 */
export const MAX_REQUEST_DEADLINE_MS = 240_000;

export function clampDeadline(timeoutMs: number): number {
  return Math.min(Math.max(timeoutMs, 0), MAX_REQUEST_DEADLINE_MS);
}

/**
 * The deadlines a server→client wait runs on — one object, read at call time.
 *
 * A deadlocked turn is indistinguishable from a slow one except by how long it takes to
 * end, so the loopback harness needs "how long" to be small: shrunk to tens of
 * milliseconds, a deadlock test goes red in a quarter of a second instead of 30.
 *
 * Injectable, not merely configurable: `setDeadlinesForTest()` mutates this object and
 * hands back the restore, and every call site reads the field rather than closing over a
 * constant. Callers that take an explicit `timeoutMs` still win — these are the defaults
 * and the floor beneath them.
 */
export interface Deadlines {
  /** Reading app state is expected to be near-instant. `handleAppQuery`. */
  appQueryMs: number;
  /** Commands do real work (devtools compile/deploy shells out). `handleAppCommand`. */
  appCommandMs: number;
  /** Floor under a caller-supplied command timeout — a command needs *some* room. */
  appCommandMinMs: number;
  /** How long a command waits for the iframe to call `app.register()`. `waitForAppReady`. */
  appReadyMs: number;
  /** Default life of a confirm/permission dialog before it is withdrawn and denied. */
  dialogMs: number;
  /** Default life of a user prompt. Production value is the whole request budget. */
  userPromptMs: number;
  /** Default wait for the frontend to report on a rendered action. */
  renderFeedbackMs: number;
}

const PRODUCTION_DEADLINES: Readonly<Deadlines> = Object.freeze({
  appQueryMs: 5_000,
  appCommandMs: 30_000,
  appCommandMinMs: 1_000,
  appReadyMs: 5_000,
  dialogMs: 60_000,
  userPromptMs: MAX_REQUEST_DEADLINE_MS,
  renderFeedbackMs: 3_000,
});

export const deadlines: Deadlines = { ...PRODUCTION_DEADLINES };

/**
 * Shrink deadlines for a test. Returns the restore — call it in `afterEach`, or the next
 * file in the same Bun process inherits a 50ms app-command timeout and fails for reasons
 * that have nothing to do with it.
 */
export function setDeadlinesForTest(overrides: Partial<Deadlines>): () => void {
  const previous = { ...deadlines };
  Object.assign(deadlines, overrides);
  return () => Object.assign(deadlines, previous);
}
