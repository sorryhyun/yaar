// Everything the view can *do*, grouped by domain. All of it drives the store and
// reports through the status line; none of it renders.

export { runAction } from './run-action.js';
export { installApp, refreshData, uninstallApp } from './catalog.js';
export { updateAllApps } from './update-all.js';
export type { UpdateAllSummary } from './update-all.js';
export { cancelPublish, confirmPublish, publishApp } from './publish.js';
export { refreshAccount, signIn, signOut } from './auth.js';
export { refreshGithubStatus, startGithubStatusPolling } from './github-status.js';
