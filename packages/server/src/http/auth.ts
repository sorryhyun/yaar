/**
 * Token-based authentication for remote mode.
 * When IS_REMOTE is true, all HTTP/WS endpoints (except /health) require a valid token.
 */

import { randomBytes } from 'crypto';
import { extname } from 'path';
import { IS_REMOTE } from '../config.js';

let remoteToken: string | null = null;

/** Generate and store a new remote access token. */
export function generateRemoteToken(): string {
  remoteToken = randomBytes(32).toString('base64url');
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

/** Routes that serve static frontend assets (no secrets, needed to bootstrap the app). */
function isStaticAsset(pathname: string): boolean {
  if (pathname === '/' || pathname === '/index.html') return true;
  const ext = extname(pathname);
  return [
    '.js',
    '.css',
    '.html',
    '.svg',
    '.png',
    '.ico',
    '.woff',
    '.woff2',
    '.ttf',
    '.otf',
  ].includes(ext);
}

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
