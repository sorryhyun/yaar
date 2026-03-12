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

export const PUBLIC_ENDPOINTS: EndpointMeta[] = [
  {
    method: 'POST',
    path: '/api/verb',
    response: 'JSON',
    description:
      'Execute a yaar:// verb from an iframe app. Body: `{ verb, uri, payload? }`. Restricted to allowed URI prefixes.',
  },
];

/** URI prefixes accessible to iframe apps. Phase 2: add 'yaar://appstorage' here. */
const IFRAME_ALLOWED_URI_PREFIXES = ['yaar://browser'];

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
  const allowed = IFRAME_ALLOWED_URI_PREFIXES.some((prefix) => uri.startsWith(prefix));
  if (!allowed) {
    return errorResponse('URI not accessible to iframe apps', 403);
  }

  // Dispatch to ResourceRegistry
  try {
    const registry = initRegistry();
    const result = await registry.execute(verb, uri, body.payload);
    return jsonResponse(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Verb execution failed';
    return errorResponse(message, 500);
  }
}
