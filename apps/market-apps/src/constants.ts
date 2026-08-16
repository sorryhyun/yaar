import type { Account, GithubStatus } from './types.js';

/**
 * The marketplace. There is one, it is fixed, and the app is compiled against it —
 * so it is a constant rather than configurable state. The host's own `MARKET_URL`
 * (server `config/env.ts`) points at the same place for install/publish.
 */
export const MARKET_DOMAIN = 'https://yaarmarket.vercel.app';

/** One call returns components + unresolved incidents, so we only need this one. */
export const GITHUB_STATUS_URL = 'https://www.githubstatus.com/api/v2/summary.json';

/**
 * The GitHub components a publish actually depends on. Publishing uploads blobs
 * and writes a commit through the REST Git Data API, so an Actions or Pages
 * outage is real but irrelevant here — listing them would cry wolf.
 */
export const GITHUB_PUBLISH_COMPONENTS = ['API Requests', 'Git Operations'];

/** Statuspage severities, least to most severe — index order is the comparison. */
export const GITHUB_SEVERITY = [
  'operational',
  'under_maintenance',
  'degraded_performance',
  'partial_outage',
  'major_outage',
];

/** Re-check while the window is open. Slow on purpose: an outage lasts minutes. */
export const GITHUB_STATUS_POLL_MS = 60_000;

/**
 * Host app-list reads may briefly lag a successful install. During this short
 * window, retain the marketplace version that triggered the install rather than
 * trusting an older list snapshot.
 */
export const INSTALL_RECONCILIATION_GRACE_MS = 15_000;

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

/**
 * The authors treated as first-party ("YAAR Official"). Compared case-insensitively,
 * so 'YAAR' as it displays in the UI and 'yaar' both match.
 */
export const OFFICIAL_AUTHORS = ['yaar', 'standingbehindnv@gmail.com'];
