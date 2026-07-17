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
 */

import { join, dirname } from 'path';
import { mkdir, readFile, writeFile, unlink, chmod } from 'fs/promises';
import { getConfigDir, getPort, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } from '../../config.js';
import { openUrl } from '../../lib/open-url.js';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

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
  /** False when GOOGLE_CLIENT_ID/SECRET are absent — login cannot even be attempted. */
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
  return GOOGLE_CLIENT_ID !== '' && GOOGLE_CLIENT_SECRET !== '';
}

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
      'Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env ' +
        '(the client must be of type "Desktop app").',
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

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: pending.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: pending.verifier,
    }),
  });

  const body = (await res.json()) as {
    id_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!res.ok || !body.id_token) {
    throw new Error(
      `Token exchange failed (${res.status}): ${body.error_description ?? body.error ?? 'unknown error'}`,
    );
  }

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

  console.log(`[market] Signed in to Google as ${claims.email}`);
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

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: creds.refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  const body = (await res.json()) as {
    id_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!res.ok || !body.id_token) {
    // invalid_grant means the refresh token is revoked or expired for good —
    // keeping it would just fail every hour, so drop it and force a re-login.
    if (body.error === 'invalid_grant') {
      await clearCredentials();
      throw new Error('Google session expired. Sign in again.');
    }
    throw new Error(
      `Token refresh failed (${res.status}): ${body.error_description ?? body.error ?? 'unknown error'}`,
    );
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
