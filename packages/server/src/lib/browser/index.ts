/**
 * Browser automation library — re-exports.
 */

export { HeadlessServerBrowser, getBrowserProvider } from './pool.js';
export { LocalUserBrowser } from './local-user-browser.js';
export { CdpBrowserProvider } from './cdp-provider.js';
// Back-compat aliases (deprecated — prefer HeadlessServerBrowser / getBrowserProvider).
export { BrowserPool, getBrowserPool } from './pool.js';
export { BrowserSession } from './session.js';
export type { BrowserSessionUpdate } from './session.js';
export type {
  PageState,
  PageContent,
  BrowserProvider,
  BrowserProviderStats,
  AdoptedTab,
} from './types.js';
