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
  /** GOOGLE_CLIENT_ID/SECRET are set on the server — sign-in is even possible. */
  configured: boolean;
  signedIn: boolean;
  email: string | null;
  /** A consent screen is open in the browser and has not come back yet. */
  pending: boolean;
  /** App ids this publisher owns, from the marketplace. */
  ownedApps: string[];
};

export type ApiPayload = {
  apps?: ListedApp[];
  marketApps?: ListedApp[];
  installed?: InstalledApp[];
  installedApps?: InstalledApp[];
};
