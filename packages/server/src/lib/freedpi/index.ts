/**
 * A loopback proxy that gets TLS past SNI-matching DPI. **On by default**
 * (`YAAR_FREEDPI=0` turns it off).
 *
 * Wired by the lifecycle, consumed by `lib/browser/chrome.ts` (as `--proxy-server`) and
 * `lib/ssrf.ts` (as `fetch`'s `proxy` option). Being on costs an unblocked network one
 * loopback hop and nothing else: `policy.ts` starts every host on the direct path and
 * only an injected-looking reset moves it up a rung.
 */

export { createFreeDpiProxy, parseConnect } from './proxy.js';
export { setActiveFreeDpi, getFreeDpiProxyUrl, isFreeDpiActive } from './active.js';
export { HostPolicy, canReplay, escalate } from './policy.js';
export { DohResolver, refusalForAddress, isIpLiteral, DEFAULT_DOH_URL } from './resolve.js';
export { planSplit, segmentsFor, recordsFor, isClientHello, findHostname } from './split.js';
export type { FreeDpiConfig, FreeDpiProxy, Outcome, Route } from './types.js';
export type { HostPolicyOptions, ReplayState } from './policy.js';
export type { SplitPlan } from './split.js';
export type { Resolver } from './resolve.js';
