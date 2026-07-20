// ── Shared type definitions ──────────────────────────────────────────────────

export type ListedApp = {
  id: string;
  name: string;
  description?: string;
  version?: string;
  author?: string;
  icon?: string;
  installed?: boolean;
};

export type InstalledApp = {
  id: string;
  name: string;
  hasSkill?: boolean;
  /** 'system' apps are built-in and cannot be uninstalled. */
  kind?: string;
};

/** A card in the list — a marketplace app, an installed app, or both. */
export type DisplayApp = ListedApp & {
  kind?: string;
  /** Installed locally but not (yet) on the marketplace — publishable, not installable. */
  notPublished?: boolean;
};

/**
 * Publisher sign-in state, mirrored from the server's Google auth + the
 * marketplace's GET /api/me. The ID token never reaches this iframe — the server
 * makes the marketplace call and hands back only the email and owned app ids.
 */
export type Account = {
  /**
   * Sign-in is possible at all. True on a stock install — YAAR bakes in its own
   * OAuth client id — and false only when GOOGLE_CLIENT_ID is explicitly blanked.
   */
  configured: boolean;
  signedIn: boolean;
  email: string | null;
  /** A consent screen is open in the browser and has not come back yet. */
  pending: boolean;
  /** App ids this publisher owns, from the marketplace. */
  ownedApps: string[];
};

/**
 * GitHub health, as it bears on publishing.
 *
 * Publishing commits through GitHub's Git Data API, so a GitHub-side outage
 * surfaces here as an opaque 5xx from the marketplace. This is only ever a
 * *hint* — GitHub can be green while a publish still fails for reasons local
 * to you (expired sign-in, not the app's owner), so the banner says
 * "may fail", never "will fail".
 */
export type GithubStatus = {
  /** False while healthy — the banner renders nothing at all in that case. */
  degraded: boolean;
  /** Worst status among the components publishing depends on. */
  level: string;
  /** Which of those components are unhealthy, e.g. ["API Requests"]. */
  components: string[];
  /** The newest unresolved incident's latest update, when there is one. */
  incident: string | null;
};

export type ApiPayload = {
  apps?: ListedApp[];
  marketApps?: ListedApp[];
  installed?: InstalledApp[];
  installedApps?: InstalledApp[];
};
