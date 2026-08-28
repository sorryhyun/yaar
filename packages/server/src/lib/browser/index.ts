/**
 * Browser automation library — re-exports.
 */

export {
  HeadlessServerBrowser,
  getHeadlessBrowser,
  getLocalBrowser,
  isForceHeadless,
  getBrowserProvider,
} from './pool.js';
export { LocalUserBrowser } from './local-user-browser.js';
export { CdpBrowserProvider } from './cdp-provider.js';
// Back-compat aliases (deprecated — prefer getHeadlessBrowser / getLocalBrowser).
export { BrowserPool, getBrowserPool } from './pool.js';
export { BrowserSession } from './session.js';
export type { BrowserSessionUpdate, ShieldProfile, RequestBlockStats } from './session.js';
export type {
  PageState,
  PageContent,
  BrowserProvider,
  BrowserProviderStats,
  AdoptedTab,
} from './types.js';
