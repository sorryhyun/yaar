/**
 * The marketplace's view of the signed-in publisher.
 *
 * `GET /api/me` on the marketplace answers "who am I and which apps do I own?",
 * authenticated by the Google ID token. That token lives only on this machine
 * (`google-auth.ts`), so the call is made **here, server-side** — the market-apps
 * iframe learns the email and the app ids without ever holding a bearer credential
 * for the whole publisher account.
 */

import { MARKET_URL } from '../../config.js';
import { getIdToken } from './google-auth.js';

/**
 * How long a fetched catalog stays usable for the publish version guard.
 *
 * Staleness is **fail-open by construction**: an older catalog can only name a
 * *lower* published version than reality, which makes the guard more permissive,
 * never wrongly blocking a publish. The marketplace enforces its own version policy
 * server-side and stays the authority — this only decides how often the local
 * courtesy check pays a round trip in front of the Publish button.
 */
const CATALOG_TTL_MS = 5 * 60 * 1000;

let catalogCache: { versions: Map<string, string>; fetchedAt: number } | null = null;
/** One in-flight fetch shared by concurrent callers, so a warm + a prepare don't race two. */
let catalogInFlight: Promise<Map<string, string> | null> | null = null;

export interface PublisherIdentity {
  /** The signed-in email, or null when signed out. Mirrors the marketplace's answer. */
  email: string | null;
  /** App ids this publisher owns (first-come ownership in the marketplace's owners.json). */
  apps: string[];
}

const SIGNED_OUT: PublisherIdentity = { email: null, apps: [] };

/**
 * Fetch the publisher's identity + owned apps from the marketplace.
 *
 * Best-effort: a signed-out session, an expired grant, or an unreachable
 * marketplace all resolve to `SIGNED_OUT` rather than throwing. The UI treats
 * "no owned apps" the same in every case, and local sign-in state (from
 * `getAuthStatus`) is the authority on whether a login exists at all.
 */
export async function fetchMe(): Promise<PublisherIdentity> {
  // The Market Apps window reads this on mount, and the Publish button is one press
  // away from there. Warm the catalog now, off the critical path, so the version
  // guard in `publish_prepare` is a memory lookup instead of a Vercel round trip
  // the user waits on with the dialog not yet open.
  primePublishedVersions();

  let idToken: string | null;
  try {
    idToken = await getIdToken();
  } catch {
    return SIGNED_OUT; // e.g. the refresh grant was revoked — treat as signed out here.
  }
  if (!idToken) return SIGNED_OUT;

  let res: Response;
  try {
    res = await fetch(`${MARKET_URL}/api/me`, {
      headers: { Authorization: `Bearer ${idToken}` },
    });
  } catch {
    return SIGNED_OUT; // marketplace unreachable
  }
  if (!res.ok) return SIGNED_OUT;

  const body = (await res.json().catch(() => null)) as {
    email?: string;
    apps?: string[];
  } | null;

  return {
    email: body?.email ?? null,
    apps: Array.isArray(body?.apps)
      ? body.apps.filter((a): a is string => typeof a === 'string')
      : [],
  };
}

/**
 * The whole public catalog as `id → version`, or null when it can't be read.
 *
 * The catalog (`GET /api/apps`) is public and uncredentialed — it is the same
 * listing the market-apps iframe fetches — so no ID token is attached. Sourced from
 * `MARKET_URL`, the exact origin `uploadTarball` publishes to, so the comparison is
 * against where the bytes would actually land.
 *
 * A failed read is **not** cached: the next caller retries rather than inheriting a
 * five-minute "catalog unreachable".
 */
async function fetchCatalogVersions(): Promise<Map<string, string> | null> {
  let res: Response;
  try {
    res = await fetch(`${MARKET_URL}/api/apps`);
  } catch {
    return null; // catalog unreachable — caller falls back to "allow"
  }
  if (!res.ok) return null;

  const body = (await res.json().catch(() => null)) as {
    apps?: unknown[];
    marketApps?: unknown[];
  } | null;
  if (!body) return null;

  const versions = new Map<string, string>();
  const entries = [
    ...(Array.isArray(body.apps) ? body.apps : []),
    ...(Array.isArray(body.marketApps) ? body.marketApps : []),
  ];
  for (const entry of entries) {
    if (entry && typeof entry === 'object') {
      const e = entry as { id?: unknown; version?: unknown };
      if (typeof e.id === 'string' && typeof e.version === 'string') versions.set(e.id, e.version);
    }
  }

  catalogCache = { versions, fetchedAt: Date.now() };
  return versions;
}

/** The cached catalog, refetched past its TTL. Never rejects. */
async function catalogVersions(): Promise<Map<string, string> | null> {
  if (catalogCache && Date.now() - catalogCache.fetchedAt < CATALOG_TTL_MS) {
    return catalogCache.versions;
  }
  if (!catalogInFlight) {
    catalogInFlight = fetchCatalogVersions().finally(() => {
      catalogInFlight = null;
    });
  }
  return catalogInFlight;
}

/**
 * Start filling the catalog cache without waiting for it. For callers that know a
 * publish is plausibly imminent and would rather spend the round trip now than in
 * front of a button press.
 */
export function primePublishedVersions(): void {
  void catalogVersions();
}

/**
 * The version the marketplace currently serves for `appId`, or null if the app is
 * unpublished or the public catalog can't be read.
 */
export async function fetchPublishedVersion(appId: string): Promise<string | null> {
  return (await catalogVersions())?.get(appId) ?? null;
}

/** Test-only: drop the cached catalog so the next read refetches. */
export function __resetCatalogCacheForTest(): void {
  catalogCache = null;
  catalogInFlight = null;
}
