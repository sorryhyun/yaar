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
 * **YAAR's transport is not the outermost bound.** Every one of these waits is reached
 * through an MCP tool call, and the caller has a transport too: the spawned CLI wraps each
 * MCP POST in an abort timer of `MCP_TOOL_TIMEOUT`, falling back to **60s**. Its
 * *tool-call* clock is effectively unbounded by default, so nothing about a long tool call
 * looked wrong — the HTTP request underneath it was simply aborted at 60s with
 * `DOMException("The operation timed out.", "TimeoutError")`. Measured on a 240s user
 * prompt: `tool_result "The operation timed out." durationMs: 60019`, the agent moved on,
 * and the dialog stayed on the user's screen for three more minutes — answerable, and
 * wired to a request that had stopped being read. A deadline is only reportable if it
 * fires before *whoever is waiting* gives up, and neither transport is the one waiting.
 *
 * So there are three bounds, and they nest: an inner deadline fits inside the tool-call
 * ceiling we ask the caller for, which fits inside the transport's, each with room to
 * serialize and flush the answer.
 *
 * This module owns the *only* mutable `deadlines` object in the server. `config.ts`
 * re-exports the same binding; nothing may copy it, or `setDeadlinesForTest()` would
 * shrink one copy and leave call sites reading another.
 */

/** `Bun.serve`'s idle timeout, in seconds. 255 is the protocol maximum — a ceiling, not a choice. */
export const TRANSPORT_IDLE_TIMEOUT_S = 255;

/**
 * How long the caller of a YAAR tool must be willing to wait, in ms.
 *
 * Handed to the spawned CLI as `MCP_TOOL_TIMEOUT` (`config/providers/claude.ts`), which is
 * the one knob feeding both of its clocks — the per-call tool timeout and the abort timer
 * on the MCP POST, whose 60s fallback is shorter than the waits YAAR deliberately runs. A
 * question put to the user is meant to hold the turn open, not to be given up on while
 * they read it. Sits above every inner deadline and below YAAR's own transport bound, so
 * the party that reports an expiry is always YAAR, with a real reason ("nobody answered"),
 * rather than the caller with a bare timeout.
 *
 * Raising it does not let a tool call run longer: `clampDeadline` still bounds every wait
 * to `MAX_REQUEST_DEADLINE_MS`. It only stops the caller from walking away first.
 */
export const MCP_TOOL_CALL_TIMEOUT_MS = 250_000;

/**
 * The longest a server-side deadline may hold an inbound request open.
 * Strictly below the tool-call and transport bounds, so expiry always reaches the caller.
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
  /** How long a command waits for the iframe to register via `defineApp()`. `waitForAppReady`. */
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
