/**
 * Verb proxy route — exposes a subset of yaar:// verbs to iframe apps.
 *
 * POST /api/verb
 * Body: { verb, uri, payload? }
 * Returns: VerbResult JSON
 *
 * Only URIs matching IFRAME_ALLOWED_URI_PREFIXES are accessible.
 * Iframe token auth is reused (X-Iframe-Token header).
 */

import { MAX_UPLOAD_SIZE } from '../../config.js';
import { errorResponse, jsonResponse, type EndpointMeta } from '../utils.js';
import { readBodyWithLimit, BodyTooLargeError } from '../body-limit.js';
import { initRegistry } from '../../handlers/index.js';
import type { Verb } from '../../handlers/uri-registry.js';
import { validateIframeToken } from '../iframe-tokens.js';
import { subscriptionRegistry } from '../subscriptions.js';

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
 * URI patterns accessible to iframe apps via POST /api/verb.
 * Each entry is either an exact match or a prefix (trailing `/` means prefix).
 */
export const IFRAME_ALLOWED_URI_PREFIXES = [
  'yaar://browser/',
  'yaar://storage/',
  'yaar://apps/self/storage/',
  'yaar://windows/',
  'yaar://windows', // exact — for list('yaar://windows')
  'yaar://http', // exact — for invoke('yaar://http', { url, ... })
];

/** Check if a URI is allowed by the given prefixes. */
function isUriAllowed(uri: string, prefixes: string[]): boolean {
  return prefixes.some(
    (entry) =>
      uri === entry || // exact match
      (entry.endsWith('/') && uri.startsWith(entry)), // prefix match
  );
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

      const effectivePermissions = tokenEntry.permissions ?? IFRAME_ALLOWED_URI_PREFIXES;
      if (!isUriAllowed(body.uri, effectivePermissions)) {
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

  // Compute effective permissions: per-token if available, otherwise default allowlist
  const effectivePermissions = tokenEntry?.permissions ?? IFRAME_ALLOWED_URI_PREFIXES;

  // Allowlist check
  if (!isUriAllowed(uri, effectivePermissions)) {
    return errorResponse('URI not accessible to iframe apps', 403);
  }

  // Resolve `self` → real appId from iframe token
  let resolvedUri = uri;
  if (uri.startsWith('yaar://apps/self/')) {
    if (!tokenEntry?.appId) {
      return errorResponse('Cannot resolve "self": no appId in iframe token', 403);
    }
    resolvedUri = uri.replace('yaar://apps/self/', `yaar://apps/${tokenEntry.appId}/`);
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
