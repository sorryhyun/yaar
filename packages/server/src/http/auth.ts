/**
 * Token-based authentication for remote mode.
 * When IS_REMOTE is true, all HTTP/WS endpoints (except /health) require a valid token.
 */

import { randomBytes } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
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
 * Returns true if the request is authorized (or auth is not required).
 * Sends 401 and returns false if unauthorized.
 */
export function checkHttpAuth(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  if (!IS_REMOTE || !remoteToken) return true;

  // /health is always exempt
  if (url.pathname === '/health') return true;

  const token = extractToken(req, url);
  if (token === remoteToken) return true;

  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unauthorized' }));
  return false;
}

/**
 * Validate auth for WebSocket upgrades.
 * Returns true if authorized.
 */
export function checkWsAuth(url: URL): boolean {
  if (!IS_REMOTE || !remoteToken) return true;
  return url.searchParams.get('token') === remoteToken;
}

/** Extract token from Authorization header or query param. */
function extractToken(req: IncomingMessage, url: URL): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return url.searchParams.get('token');
}
