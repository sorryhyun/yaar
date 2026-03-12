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

export const PUBLIC_ENDPOINTS: EndpointMeta[] = [
  {
    method: 'POST',
    path: '/api/verb',
    response: 'JSON',
    description:
      'Execute a yaar:// verb from an iframe app. Body: `{ verb, uri, payload? }`. Restricted to allowed URI prefixes.',
  },
];

/**
 * URI patterns accessible to iframe apps via POST /api/verb.
 * Each entry is either an exact match or a prefix (trailing `/` means prefix).
 */
const IFRAME_ALLOWED_URI_PREFIXES = [
  'yaar://browser/',
  'yaar://apps/self/storage/',
  'yaar://windows/',
  'yaar://windows', // exact — for list('yaar://windows')
];

/** Check if a URI is allowed by the iframe allowlist. */
function isUriAllowed(uri: string): boolean {
  return IFRAME_ALLOWED_URI_PREFIXES.some(
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

export async function handleVerbRoutes(req: Request, url: URL): Promise<Response | null> {
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

  // Allowlist check
  if (!isUriAllowed(uri)) {
    return errorResponse('URI not accessible to iframe apps', 403);
  }

  // Resolve `self` → real appId from iframe token
  let resolvedUri = uri;
  if (uri.startsWith('yaar://apps/self/')) {
    const token = req.headers.get('X-Iframe-Token');
    const entry = token ? validateIframeToken(token) : null;
    if (!entry?.appId) {
      return errorResponse('Cannot resolve "self": no appId in iframe token', 403);
    }
    resolvedUri = uri.replace('yaar://apps/self/', `yaar://apps/${entry.appId}/`);
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
