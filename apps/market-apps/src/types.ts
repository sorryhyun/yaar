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
  /** 'system' apps are built-in and cannot be uninstalled. */
  kind?: string;
  /** The local app.json version — compared against the published version to gate publishing. */
  version?: string;
};

/** A card in the list — a marketplace app, an installed app, or both. */
export type DisplayApp = ListedApp & {
  kind?: string;
  /** Installed locally but not (yet) on the marketplace — publishable, not installable. */
  notPublished?: boolean;
  /**
   * The locally installed app.json version, when known. Distinct from `version`,
   * which on a marketplace card is the *published* version. The publish button is
   * disabled when this is not newer than the published one.
   */
  installedVersion?: string;
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

/**
 * The publisher agreement, as it stands for the signed-in publisher.
 *
 * The `text` is the host's copy, not the app's: the dialog must show the words the
 * server will hold the user to, so a stale bundled app can never present terms that
 * differ from the ones being accepted.
 */
export type PublisherTerms = {
  version: string;
  /** True when this publisher already accepted this exact version — no checkbox needed. */
  accepted: boolean;
  text: string;
};

/**
 * The host's answer to `publish_prepare`: an app has been packaged and its exact
 * bytes frozen server-side under `publicationId`, awaiting confirmation. The digest
 * + size are what the confirmation dialog shows before we commit to uploading.
 */
export type PreparedPublication = {
  publicationId: string;
  appId: string;
  version: string | null;
  artifactSha256: string;
  manifestSha256: string;
  byteLength: number;
  expiresAt: string;
  /**
   * Optional only because this response is not schema-validated. A host that sends
   * no terms simply gets no checkbox here — the gate that actually blocks the upload
   * lives on the server, so a missing field costs a clear refusal, not a bypass.
   */
  terms?: PublisherTerms;
};

/** The host's answer to `publish_confirm`. `published` is the only field always present. */
export type ConfirmOutcome = {
  published: boolean;
  status?: 'published' | 'drift_detected' | 'terms_required' | 'expired' | 'not_found' | 'error';
  message?: string;
  drift?: { drifted: boolean; changedFiles: string[] };
};

/**
 * A publish awaiting the user's confirmation. Holds the frozen digest to show and,
 * once a confirm comes back reporting drift, the list of files that changed since
 * prepare — so the dialog can warn before shipping the frozen snapshot.
 */
export type PendingPublish = {
  app: { id: string; name: string };
  summary: PreparedPublication;
  /** Present only after a confirm returned `drift_detected`. */
  drift?: { changedFiles: string[] };
};
