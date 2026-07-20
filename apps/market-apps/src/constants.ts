// ── Constants ────────────────────────────────────────────────────────────────

import type { Account, GithubStatus } from './types.js';

export const STORAGE_DOMAIN_KEY = 'market_apps/domain.txt';
export const DEFAULT_MARKET_DOMAIN = 'https://yaarmarket.vercel.app';

/** One call returns components + unresolved incidents, so we only need this one. */
export const GITHUB_STATUS_URL = 'https://www.githubstatus.com/api/v2/summary.json';

/**
 * The GitHub components a publish actually depends on. Publishing uploads blobs
 * and writes a commit through the REST Git Data API, so an Actions or Pages
 * outage is real but irrelevant here — listing them would cry wolf.
 */
export const GITHUB_PUBLISH_COMPONENTS = ['API Requests', 'Git Operations'];

/** Re-check while the window is open. Slow on purpose: an outage lasts minutes. */
export const GITHUB_STATUS_POLL_MS = 60_000;

/** The default and the fallback — an unreachable status page means "say nothing". */
export const GITHUB_STATUS_HEALTHY: GithubStatus = {
  degraded: false,
  level: 'operational',
  components: [],
  incident: null,
};

export const SIGNED_OUT_ACCOUNT: Account = {
  configured: false,
  signedIn: false,
  email: null,
  pending: false,
  ownedApps: [],
};
