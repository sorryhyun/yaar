/**
 * Token-based authentication for remote mode.
 * When IS_REMOTE is true, all HTTP/WS endpoints (except /health) require a valid token.
 */

import { extname } from 'path';
import { IS_REMOTE } from '../config.js';

let remoteToken: string | null = null;

/** Generate and store a new remote access token. */
export function generateRemoteToken(): string {
  remoteToken = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  return remoteToken;
}

/** Get the current remote token (null if not generated). */
export function getRemoteToken(): string | null {
  return remoteToken;
}

/**
 * Validate auth for HTTP requests.
 * Returns a 401 Response if unauthorized, or null if authorized.
 */
export function checkHttpAuth(req: Request, url: URL): Response | null {
  if (!IS_REMOTE || !remoteToken) return null;

  // /health is always exempt
  if (url.pathname === '/health') return null;

  // MCP endpoints have their own bearer token auth — exempt from remote auth
  if (url.pathname.startsWith('/mcp/')) return null;

  // Static frontend assets must load without auth so the client-side JS
  // can read the #remote=<token> hash fragment and attach it to API/WS calls.
  if (isStaticAsset(url.pathname)) return null;

  const token = extractToken(req, url);
  if (token === remoteToken) return null;

  return Response.json({ error: 'Unauthorized' }, { status: 401 });
}

/**
 * Validate auth for WebSocket upgrades.
 * Returns true if authorized.
 */
export function checkWsAuth(url: URL): boolean {
  if (!IS_REMOTE || !remoteToken) return true;
  return url.searchParams.get('token') === remoteToken;
}

/**
 * Routes that serve static frontend assets (no secrets, needed to bootstrap the app).
 *
 * Exported for tests: `IS_REMOTE` is fixed at module load, so the predicate is the
 * honest unit under test rather than a process with REMOTE=1 in its environment.
 *
 * This is a question about *where* a path is served from, not what it is named. It
 * used to be a pure extension test, which meant remote auth was bypassable by
 * choosing a filename: in REMOTE mode `GET /api/storage/anything.png` and
 * `POST /api/storage/payload.js` skipped the token entirely, because the check ran
 * before any `/api` check and only looked at the suffix. Storage holds user files —
 * an attacker picks the extension, so the extension can't be the credential.
 *
 * Nothing under `/api/` or `/mcp/` is ever a static asset. Everything else is
 * served by static.ts out of the frontend build, and must load unauthenticated so
 * the client JS can read the `#remote=<token>` fragment and attach it to the calls
 * that follow.
 */
export function isStaticAsset(pathname: string): boolean {
  if (pathname.startsWith('/api/') || pathname.startsWith('/mcp/')) return false;
  if (pathname === '/' || pathname === '/index.html') return true;
  // The SPA fallback in static.ts serves index.html for unknown non-/api paths, so an
  // extensionless route (/settings, /window/3) is a frontend route, not an asset.
  const ext = extname(pathname);
  if (!ext) return true;
  return ASSET_EXTENSIONS.includes(ext);
}

/** Extensions the frontend build emits. */
const ASSET_EXTENSIONS = [
  '.js',
  '.mjs',
  '.map',
  '.css',
  '.html',
  '.json',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
];

/** Extract token from Authorization header, query param, or Referer. */
function extractToken(req: Request, url: URL): string | null {
  const authHeader = req.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  const queryToken = url.searchParams.get('token');
  if (queryToken) return queryToken;

  // Iframe apps are loaded with ?token=... in their URL.
  // Their fetch() calls don't include the token, but the browser sends the
  // iframe's URL as the Referer header — extract the token from there.
  const referer = req.headers.get('referer');
  if (referer) {
    try {
      return new URL(referer).searchParams.get('token');
    } catch {
      // Malformed referer — ignore
    }
  }
  return null;
}
