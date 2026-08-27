/**
 * `YAAR_FREEDPI=1` — a loopback proxy that gets TLS past SNI-matching DPI.
 *
 * Wired in `lifecycle.startFreeDpi()`, consumed by `lib/browser/chrome.ts` (as
 * `--proxy-server`) and `lib/ssrf.ts` (as `fetch`'s `proxy` option). Off unless the
 * flag is set: it is a censorship-circumvention tool, not a default network path.
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
