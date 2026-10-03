/**
 * The door half of preview fault rules (`features/window/preview-faults.ts`): given the
 * caller and the call it is about to make, stall it, fail it, or let it through.
 *
 * Each door asks once, after its own gates and before it does the work, so a faulted call
 * still has to be one the app may make. A denied call answers 403 as it always did, and a
 * rule never turns a forbidden call into a "simulated" failure that hides the real one.
 */

import { clampDeadline, MAX_REQUEST_DEADLINE_MS } from '../config.js';
import { getSessionHub } from '../session/session-hub.js';
import { takeMatchingFault, type FaultTarget } from '../features/window/preview-faults.js';
import { isPreviewWindow } from '../features/window/app-protocol.js';
import { createLogger } from '../observability/log.js';
import type { AppPrincipal } from './access.js';
import { jsonResponse } from './utils.js';

const log = createLogger('preview-faults');

/** Resolves after `ms`, or as soon as the client gives up on the request. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done);
  });
}

/**
 * What a door should do with this call: a `Response` to answer with instead of doing the
 * work, or `null` to carry on (possibly after a stall).
 *
 * `shape` picks the error body the calling SDK reads. The verb door's envelope is
 * `{ ok: false, error }` and the SDK retries a 503 that says `retryable`; the fetch and
 * subscribe doors answer `{ error }`, which their callers throw as the request's failure.
 */
export async function applyPreviewFault(
  principal: AppPrincipal,
  target: FaultTarget,
  req: Request,
  shape: 'envelope' | 'error',
): Promise<Response | null> {
  const rules = getSessionHub()
    .get(principal.sessionId)
    ?.windowState.getWindowFaults(principal.windowId, principal.monitorId, isPreviewWindow);
  if (!rules || rules.length === 0) return null;
  const rule = takeMatchingFault(rules, target);
  if (!rule) return null;

  log.info('fault applied', { kind: rule.kind, verb: target.verb, hits: rule.hits });

  if (rule.kind === 'hang') {
    // Bounded by the request ceiling: a hang that outlived the transport would only ever
    // be reported by the socket closing, which reads as a server fault, not the app's.
    await wait(MAX_REQUEST_DEADLINE_MS, req.signal);
    return jsonResponse(
      shape === 'envelope'
        ? { ok: false, error: `Simulated hang (preview fault rule "${rule.match}")` }
        : { error: `Simulated hang (preview fault rule "${rule.match}")` },
      504,
    );
  }

  if (rule.delayMs) await wait(clampDeadline(rule.delayMs), req.signal);
  if (rule.kind === 'delay') return null;

  const message = rule.error ?? `Simulated failure (preview fault rule "${rule.match}")`;
  if (shape === 'envelope') {
    if (rule.retryable) return jsonResponse({ ok: false, error: message, retryable: true }, 503);
    return jsonResponse({ ok: false, error: message }, rule.status ?? 500);
  }
  return jsonResponse({ error: message }, rule.status ?? (target.verb ? 500 : 502));
}
