/**
 * Google OAuth — the publisher identity YAAR presents to the marketplace.
 *
 * Desktop-app flow with PKCE over a loopback redirect: YAAR opens the system
 * browser at Google's consent screen, Google redirects back to
 * `/api/auth/google/callback` on this very server, and the code is exchanged for
 * tokens here. No second listener — a Desktop client accepts any loopback port,
 * so the server we already run is the redirect target.
 *
 * What crosses to the marketplace is the **ID token**: a JWT signed by Google
 * asserting the user's email. The marketplace verifies it against Google's public
 * keys, which is why publishing needs no shared secret, no device registry, and
 * no HMAC — the email proves itself.
 *
 * ID tokens live an hour. The refresh token is what survives that, so it is the
 * one thing persisted; ID tokens are minted on demand and cached in memory only.
 *
 * **Why the token exchange goes through the marketplace.** Google's token endpoint
 * requires `client_secret` for a Desktop client, and YAAR has nowhere to keep one:
 * it is open source and installed on user machines, so anything shipped here is
 * public, and a live `GOCSPX-` value in the repo is reported to Google as a leak by
 * GitHub's scanner. So YAAR does the half it can do safely — open the consent
 * screen, hold the PKCE verifier, receive the code — and posts the code to
 * `MARKET_URL/api/auth/exchange`, which adds the secret and calls Google. Same for
 * the hourly refresh. Only tokens come back. Nothing is weakened by the detour:
 * PKCE binds the code to this process, and the marketplace was always the party
 * these ID tokens were being minted for.
 */

import { join, dirname } from 'path';
import { mkdir, readFile, writeFile, unlink, chmod } from 'fs/promises';
import { getConfigDir, getPort, GOOGLE_CLIENT_ID, MARKET_URL } from '../../config.js';
import { openUrl } from '../../lib/open-url.js';
import { createLogger } from '../../observability/log.js';

const log = createLogger('market');

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

/** Identity only. Publishing authorizes against the email, not a Google API scope. */
const SCOPES = 'openid email';

/** How long an unfinished login stays claimable before its state is swept. */
const LOGIN_TTL_MS = 10 * 60_000;

/** Refresh an ID token this long before it actually expires. */
const EXPIRY_MARGIN_MS = 60_000;

/** Persisted across restarts. The refresh token is the durable half of the login. */
interface StoredCredentials {
  refreshToken: string;
  email: string;
  /** Google's stable user id. Survives an email change; the marketplace keys on email. */
  sub: string;
  updatedAt: string;
}

interface PendingLogin {
  verifier: string;
  /** Captured at start: `setPort()` can move the port mid-flow, and Google
   *  requires the token exchange to echo the exact redirect_uri it authorized. */
  redirectUri: string;
  createdAt: number;
}

const pendingLogins = new Map<string, PendingLogin>();

let credentials: StoredCredentials | null = null;
let credentialsLoaded = false;
let cachedIdToken: { token: string; expiresAt: number } | null = null;

export interface AuthStatus {
  /**
   * False only when someone has explicitly blanked GOOGLE_CLIENT_ID/SECRET in the
   * environment — the baked-in defaults mean this is true on a stock install.
   */
  configured: boolean;
  signedIn: boolean;
  email: string | null;
  /** A login is open in the browser and has not come back yet. */
  pending: boolean;
}

function credentialsPath(): string {
  return join(getConfigDir(), 'credentials', 'google.json');
}

export function isConfigured(): boolean {
  return GOOGLE_CLIENT_ID !== '';
}

/**
 * POST to one of the marketplace's token routes.
 *
 * The marketplace holds the client secret; these routes are the only way to reach
 * Google's token endpoint from here. A 401 means the grant is dead (revoked,
 * expired, already spent) and the caller should force a re-login; anything else is
 * transient or a bug.
 */
async function marketTokenRequest(
  path: '/api/auth/exchange' | '/api/auth/refresh',
  payload: Record<string, string>,
): Promise<{ id_token: string; refresh_token?: string; expires_in?: number }> {
  let res: Response;
  try {
    res = await fetch(`${MARKET_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new Error(
      `Could not reach the marketplace to complete Google sign-in: ${(err as Error).message}`,
    );
  }

  const body = (await res.json().catch(() => ({}))) as {
    id_token?: string;
    refresh_token?: string;
    expires_in?: number;
    detail?: string;
  };

  if (!res.ok || !body.id_token) {
    const detail = body.detail ?? `HTTP ${res.status}`;
    if (res.status === 401) throw new ExpiredGrantError(detail);
    throw new Error(`Google token request failed: ${detail}`);
  }
  return body as { id_token: string; refresh_token?: string; expires_in?: number };
}

/** The grant is gone for good — the only recovery is a fresh consent. */
class ExpiredGrantError extends Error {}

function redirectUri(): string {
  // 127.0.0.1, not localhost: Google matches loopback redirects by literal host,
  // and 127.0.0.1 is the form its Desktop-client docs specify.
  return `http://127.0.0.1:${getPort()}/api/auth/google/callback`;
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/**
 * Read the claims out of an ID token *without* verifying its signature.
 *
 * Safe only because of where this token comes from: Google's token endpoint, over
 * TLS, in direct response to our own exchange. It is never a token someone handed
 * us. The marketplace, which does receive it from the network, must verify it
 * properly against Google's public keys — this is not the function for that job.
 */
function readIdTokenClaims(idToken: string): { email?: string; sub?: string; exp?: number } {
  const payload = idToken.split('.')[1];
  if (!payload) throw new Error('Malformed ID token');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
}

async function loadCredentials(): Promise<StoredCredentials | null> {
  if (credentialsLoaded) return credentials;
  try {
    credentials = JSON.parse(await readFile(credentialsPath(), 'utf-8'));
  } catch {
    credentials = null; // Not signed in yet, or the file was removed by hand.
  }
  credentialsLoaded = true;
  return credentials;
}

async function saveCredentials(next: StoredCredentials): Promise<void> {
  const path = credentialsPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  // writeFile's mode only applies on create; an existing file keeps its old bits.
  await chmod(path, 0o600).catch(() => {}); // No-op on Windows.
  credentials = next;
  credentialsLoaded = true;
}

async function clearCredentials(): Promise<void> {
  await unlink(credentialsPath()).catch(() => {});
  credentials = null;
  credentialsLoaded = true;
  cachedIdToken = null;
}

function sweepPendingLogins(): void {
  const now = Date.now();
  for (const [state, login] of pendingLogins) {
    if (now - login.createdAt > LOGIN_TTL_MS) pendingLogins.delete(state);
  }
}

/**
 * Start a login: mint PKCE + state, open the browser, return the URL.
 *
 * Returns rather than awaits — the caller polls `getAuthStatus()`. The browser
 * round-trip is a human at a consent screen, which is not a wait an HTTP request
 * should hold open.
 */
export async function beginLogin(): Promise<{ authUrl: string }> {
  if (!isConfigured()) {
    throw new Error(
      'Google OAuth is not configured. YAAR ships a working client id, so this means ' +
        'GOOGLE_CLIENT_ID is set to an empty value in the environment. Unset it to use the ' +
        'default, or set it to a client of type "Desktop app" whose secret your marketplace holds.',
    );
  }
  sweepPendingLogins();

  const state = randomToken();
  const verifier = randomToken();
  const uri = redirectUri();
  pendingLogins.set(state, { verifier, redirectUri: uri, createdAt: Date.now() });

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: uri,
    response_type: 'code',
    scope: SCOPES,
    state,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: 'S256',
    // Google issues a refresh token only for an offline grant, and only on the
    // *first* consent — without prompt=consent a re-login returns none, and
    // publishing would break an hour later with no way to recover but revoking
    // access by hand in the Google account settings.
    access_type: 'offline',
    prompt: 'consent',
  });

  const authUrl = `${AUTH_ENDPOINT}?${params}`;
  openUrl(authUrl);
  return { authUrl };
}

/**
 * Finish a login from the callback's `code` + `state`.
 *
 * `state` is the only credential this route has: it is server-minted, random, and
 * single-use, which is what lets the callback skip remote-token auth (see
 * `http/auth.ts`). Deleted on first use so a replayed callback URL is refused.
 */
export async function completeLogin(code: string, state: string): Promise<{ email: string }> {
  sweepPendingLogins();
  const pending = pendingLogins.get(state);
  if (!pending) throw new Error('Unknown or expired login state.');
  pendingLogins.delete(state);

  const body = await marketTokenRequest('/api/auth/exchange', {
    code,
    code_verifier: pending.verifier,
    redirect_uri: pending.redirectUri,
  });

  const claims = readIdTokenClaims(body.id_token);
  if (!claims.email) throw new Error('ID token carried no email claim.');

  if (!body.refresh_token) {
    throw new Error(
      'Google returned no refresh token. Revoke YAAR at https://myaccount.google.com/permissions ' +
        'and sign in again.',
    );
  }

  await saveCredentials({
    refreshToken: body.refresh_token,
    email: claims.email,
    sub: claims.sub ?? '',
    updatedAt: new Date().toISOString(),
  });

  cachedIdToken = {
    token: body.id_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };

  log.info('signed in to Google', { account: claims.email });
  return { email: claims.email };
}

/**
 * A fresh ID token for the marketplace, refreshing if the cached one is near expiry.
 * Returns null when signed out — callers surface "sign in first", not an error.
 */
export async function getIdToken(): Promise<string | null> {
  const creds = await loadCredentials();
  if (!creds) return null;

  if (cachedIdToken && cachedIdToken.expiresAt - EXPIRY_MARGIN_MS > Date.now()) {
    return cachedIdToken.token;
  }

  let body: { id_token: string; expires_in?: number };
  try {
    body = await marketTokenRequest('/api/auth/refresh', { refresh_token: creds.refreshToken });
  } catch (err) {
    // A dead grant would fail identically every hour from here on, so drop the
    // stored token and make the next call surface a sign-in prompt instead.
    if (err instanceof ExpiredGrantError) {
      await clearCredentials();
      throw new Error('Google session expired. Sign in again.');
    }
    throw err;
  }

  cachedIdToken = {
    token: body.id_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
  return cachedIdToken.token;
}

export async function getAuthStatus(): Promise<AuthStatus> {
  sweepPendingLogins();
  const creds = await loadCredentials();
  return {
    configured: isConfigured(),
    signedIn: creds !== null,
    email: creds?.email ?? null,
    pending: pendingLogins.size > 0,
  };
}

/** Forget the local session. Does not revoke the grant on Google's side. */
export async function signOut(): Promise<void> {
  await clearCredentials();
  pendingLogins.clear();
}
