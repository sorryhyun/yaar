// All app state, in four layers: the signals themselves, questions about one app,
// the install-reconciliation bookkeeping, and the derived lists the view renders.

export * from './signals.js';
export {
  hasInstalled,
  hasMarketplaceUpdate,
  installedVersionOf,
  installedVersionOrder,
  isOfficialAuthor,
  isSystem,
  ownsApp,
} from './queries.js';
export {
  markInstalledSignal,
  recordMarketplaceInstall,
  reconcileInstalledApps,
} from './installed.js';
export { displayApps, visibleApps } from './selectors.js';
