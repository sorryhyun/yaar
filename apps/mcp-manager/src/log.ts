// One place for how a failure is logged and shown.
//
// Three call sites used to hand-roll console.error + showToast with slightly
// different prefixes; `reportError` is that pair written once, so the log line
// and the toast can never drift apart. Failures that should *not* be shown to
// the user (a single malformed row inside a list that still renders) use
// `logError` alone, and one that is *routinely* expected (a port sweep's
// misses) uses `logDebug`.
import { errMsg, showToast } from '@bundled/yaar';
import { LOG_PREFIX } from './constants';

/** Log a failure without bothering the user. */
export function logError(context: string, detail?: unknown): void {
  if (detail === undefined) console.error(`${LOG_PREFIX} ${context}`);
  else console.error(`${LOG_PREFIX} ${context}`, detail);
}

/**
 * Trace-level note for a failure that is *expected* and deliberately swallowed
 * — a port sweep's per-port misses above all. `console.debug` rather than
 * `console.error` so a 6000-port scan does not flood the error channel, while a
 * *systemic* failure (every port failing for the same reason, e.g. a missing
 * permission) stays recoverable from the console instead of looking like an
 * empty network. See AGENTS.md > Traps.
 */
export function logDebug(context: string, detail?: unknown): void {
  if (detail === undefined) console.debug(`${LOG_PREFIX} ${context}`);
  else console.debug(`${LOG_PREFIX} ${context}`, detail);
}

/**
 * A low-noise note that still reaches the captured console buffer.
 *
 * `console.debug` is deliberately NOT captured by the platform's console
 * buffer, so anything logged with `logDebug` is invisible to an agent reading
 * `__console` — fine for a per-port firehose, useless for a conclusion someone
 * has to find later. Summaries go here instead.
 */
export function logInfo(context: string, detail?: unknown): void {
  if (detail === undefined) console.log(`${LOG_PREFIX} ${context}`);
  else console.log(`${LOG_PREFIX} ${context}`, detail);
}

/**
 * Log a failure *and* toast it. `context` reads as the head of the sentence:
 * `reportError('Probe failed', err)` shows "Probe failed: <reason>".
 */
export function reportError(context: string, err: unknown): void {
  logError(context, err);
  showToast(`${context}: ${errMsg(err)}`, 'error');
}