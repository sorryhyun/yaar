// Pure, dependency-free readers for everything this app receives from outside:
// app ids, versions, the two app lists, and GitHub's status page. Nothing here
// touches signals or the network — which is what makes it all trivially testable.

export { normalizeId, sameAppId } from './ids.js';
export { compareVersions } from './versions.js';
export type { VersionOrder } from './versions.js';
export { parseInstalledAny, parseMarket } from './apps.js';
export { parseGithubStatus } from './github-status.js';
