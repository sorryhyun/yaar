/**
 * Verb proxy route — exposes a subset of yaar:// verbs to iframe apps.
 *
 * POST /api/verb
 * Body: { verb, uri, payload? }
 * Returns: VerbResult JSON
 *
 * Access restricted to permissions declared in the app's app.json.
 * Apps without explicit permissions get no verb access.
 * Iframe token auth is reused (X-Iframe-Token header).
 */

import { MAX_UPLOAD_SIZE } from '../../config.js';
import { errorResponse, jsonResponse, type EndpointMeta } from '../utils.js';
import { readBodyWithLimit, BodyTooLargeError } from '../body-limit.js';
import { initRegistry } from '../../handlers/index.js';
import type { Verb } from '../../handlers/uri-registry.js';
import { validateIframeToken } from '../iframe-tokens.js';
import { subscriptionRegistry } from '../subscriptions.js';
import { getSessionHub } from '../../session/session-hub.js';

export const PUBLIC_ENDPOINTS: EndpointMeta[] = [
  {
    method: 'POST',
    path: '/api/verb',
    response: 'JSON',
    description:
      'Execute a yaar:// verb from an iframe app. Body: `{ verb, uri, payload? }`. Restricted to allowed URI prefixes.',
  },
  {
    method: 'POST',
    path: '/api/verb/subscribe',
    response: 'JSON',
    description:
      'Subscribe/unsubscribe to reactive verb URI updates. Body: `{ uri, action: "subscribe" | "unsubscribe", subscriptionId? }`.',
  },
];

/**
 * A permission entry is either:
 * - a URI prefix string (allows all verbs), or
 * - an object with `uri` and optional `verbs` array (restricts to listed verbs).
 */
export type PermissionEntry = string | { uri: string; verbs?: Verb[] };

/** No verb access by default — apps must declare permissions in app.json. */
const NO_PERMISSIONS: PermissionEntry[] = [];

/** Check if a single permission entry matches the URI. */
function uriMatches(uri: string, pattern: string): boolean {
  return (
    uri === pattern || (pattern.endsWith('/') && (uri.startsWith(pattern) || uri + '/' === pattern))
  );
}

/** Check if a URI + verb is allowed by the given permission entries. */
function isUriAllowed(uri: string, verb: Verb, entries: PermissionEntry[]): boolean {
  return entries.some((entry) => {
    if (typeof entry === 'string') {
      return uriMatches(uri, entry); // string entry → all verbs allowed
    }
    return uriMatches(uri, entry.uri) && (!entry.verbs || entry.verbs.includes(verb));
  });
}

const VALID_VERBS: Verb[] = ['describe', 'read', 'list', 'invoke', 'delete'];

interface VerbRequest {
  verb?: string;
  uri?: string;
  payload?: Record<string, unknown>;
}

interface SubscribeRequest {
  uri?: string;
  action?: 'subscribe' | 'unsubscribe';
  subscriptionId?: string;
}

export async function handleVerbRoutes(req: Request, url: URL): Promise<Response | null> {
  // ── Subscribe/unsubscribe endpoint ──
  if (url.pathname === '/api/verb/subscribe' && req.method === 'POST') {
    let body: SubscribeRequest;
    try {
      const buf = await readBodyWithLimit(req, MAX_UPLOAD_SIZE);
      body = JSON.parse(buf.toString('utf-8'));
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        return errorResponse('Request body too large', 413);
      }
      return errorResponse('Invalid JSON body', 400);
    }

    const token = req.headers.get('X-Iframe-Token');
    const tokenEntry = token ? validateIframeToken(token) : null;
    if (!tokenEntry) {
      return errorResponse('Invalid or missing iframe token', 403);
    }

    if (body.action === 'unsubscribe') {
      if (!body.subscriptionId) {
        return errorResponse('Missing "subscriptionId" for unsubscribe', 400);
      }
      subscriptionRegistry.unsubscribe(body.subscriptionId);
      return jsonResponse({ ok: true });
    }

    if (body.action === 'subscribe') {
      if (!body.uri || typeof body.uri !== 'string') {
        return errorResponse('Missing or invalid "uri" field', 400);
      }

      const effectivePermissions = tokenEntry.permissions ?? NO_PERMISSIONS;
      if (!isUriAllowed(body.uri, 'read', effectivePermissions)) {
        return errorResponse('URI not accessible to iframe apps', 403);
      }

      const subscriptionId = subscriptionRegistry.subscribe(
        token!,
        tokenEntry.windowId,
        tokenEntry.sessionId,
        body.uri,
      );
      return jsonResponse({ subscriptionId });
    }

    return errorResponse('Invalid "action". Must be "subscribe" or "unsubscribe".', 400);
  }

  // ── Main verb endpoint ──
  if (url.pathname !== '/api/verb' || req.method !== 'POST') {
    return null;
  }

  let body: VerbRequest;
  try {
    const buf = await readBodyWithLimit(req, MAX_UPLOAD_SIZE);
    body = JSON.parse(buf.toString('utf-8'));
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return errorResponse('Request body too large', 413);
    }
    return errorResponse('Invalid JSON body', 400);
  }

  // Validate verb
  const verb = body.verb as Verb;
  if (!verb || !VALID_VERBS.includes(verb)) {
    return errorResponse(`Invalid verb. Must be one of: ${VALID_VERBS.join(', ')}`, 400);
  }

  // Validate URI
  const uri = body.uri;
  if (!uri || typeof uri !== 'string') {
    return errorResponse('Missing or invalid "uri" field', 400);
  }

  // Validate iframe token (needed for both permission check and `self` resolution)
  const token = req.headers.get('X-Iframe-Token');
  const tokenEntry = token ? validateIframeToken(token) : null;

  // Compute effective permissions from app.json (no access if undeclared)
  const effectivePermissions = tokenEntry?.permissions ?? NO_PERMISSIONS;

  // Allowlist check
  if (!isUriAllowed(uri, verb, effectivePermissions)) {
    return errorResponse('URI not accessible to iframe apps', 403);
  }

  // Resolve `self` → real appId from iframe token
  let resolvedUri = uri;
  if (uri === 'yaar://apps/self' || uri.startsWith('yaar://apps/self/')) {
    if (!tokenEntry?.appId) {
      return errorResponse('Cannot resolve "self": no appId in iframe token', 403);
    }
    resolvedUri =
      uri === 'yaar://apps/self'
        ? `yaar://apps/${tokenEntry.appId}`
        : uri.replace('yaar://apps/self/', `yaar://apps/${tokenEntry.appId}/`);
  }

  // Log to session logs
  if (tokenEntry?.sessionId) {
    const session = getSessionHub().get(tokenEntry.sessionId);
    const logger = session?.getPool()?.getSessionLogger();
    if (logger) {
      const appLabel = tokenEntry.appId ?? 'unknown';
      logger.logToolUse(
        `iframe:${appLabel}`,
        { verb, uri: resolvedUri, ...(body.payload ?? {}) },
        undefined,
      );
    }
  }

  // Dispatch to ResourceRegistry
  try {
    const registry = initRegistry();
    const result = await registry.execute(verb, resolvedUri, body.payload);
    return jsonResponse(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Verb execution failed';
    return errorResponse(message, 500);
  }
}
