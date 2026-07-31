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
 * The version the marketplace currently serves for `appId`, or null if the app is
 * unpublished or the public catalog can't be read.
 *
 * The catalog (`GET /api/apps`) is public and uncredentialed — it is the same
 * listing the market-apps iframe fetches — so no ID token is attached. Sourced from
 * `MARKET_URL`, the exact origin `uploadTarball` publishes to, so the comparison is
 * against where the bytes would actually land.
 */
export async function fetchPublishedVersion(appId: string): Promise<string | null> {
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

  const entries = [
    ...(Array.isArray(body?.apps) ? body.apps : []),
    ...(Array.isArray(body?.marketApps) ? body.marketApps : []),
  ];
  for (const entry of entries) {
    if (entry && typeof entry === 'object') {
      const e = entry as { id?: unknown; version?: unknown };
      if (e.id === appId && typeof e.version === 'string') return e.version;
    }
  }
  return null;
}
