/**
 * The running bypass proxy, published for the two things that route through it.
 *
 * A module-level holder rather than a parameter threaded down, because the consumers
 * are leaves that nothing hands a lifecycle to: `lib/browser/chrome.ts` builds Chrome's
 * argv, and `lib/ssrf.ts` is a standalone utility. Importing the lifecycle from either
 * would invert the dependency and, in `ssrf.ts`'s case, drag the whole server graph into
 * a module that deliberately has almost none.
 *
 * Null whenever `YAAR_FREEDPI=1` is unset or the proxy failed to bind, and every reader
 * treats null as "route normally" — so the feature being off is the same code path the
 * server has always taken.
 */

import type { FreeDpiProxy } from './types.js';

let active: FreeDpiProxy | null = null;

/** Publish (or, with null, retract) the running proxy. Called only by the lifecycle. */
export function setActiveFreeDpi(proxy: FreeDpiProxy | null): void {
  active = proxy;
}

/** `http://127.0.0.1:<port>`, or null when traffic should not be re-routed. */
export function getFreeDpiProxyUrl(): string | null {
  return active?.proxyUrl ?? null;
}

/** Whether the bypass is live. Distinct from the flag: binding can fail. */
export function isFreeDpiActive(): boolean {
  return active !== null;
}
