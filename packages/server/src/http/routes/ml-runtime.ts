/**
 * ML runtime routes for the @bundled/yaar-ml SDK.
 *
 * - `GET /api/ml-runtime/<file>` — serve onnxruntime-web's `.wasm`/`.mjs`
 *   artifacts (the SDK points `ort.env.wasm.wasmPaths` here). Static, immutable,
 *   long-cached.
 * - `GET /api/ml-weights?url=<url>` — same-origin *streaming* proxy for model
 *   weights. Satisfies the app CSP (`connect-src 'self'`) and streams the body
 *   through without base64 double-buffering, so 100s of MB stay cheap. Enforces
 *   SSRF protection and the domain allowlist.
 */

import { join, basename, extname } from 'path';
import { getMlRuntimeDir, MIME_TYPES } from '../../config.js';
import { errorResponse, type EndpointMeta } from '../utils.js';
import { validateUrl, safeFetch } from '../../lib/ssrf.js';
import { extractDomain, isDomainAllowed } from '../../features/config/domains.js';

export const PUBLIC_ENDPOINTS: EndpointMeta[] = [
  {
    method: 'GET',
    path: '/api/ml-runtime/{file}',
    response: 'file',
    description: 'onnxruntime-web runtime artifacts (wasm/mjs) for @bundled/yaar-ml',
  },
  {
    method: 'GET',
    path: '/api/ml-weights?url={url}',
    response: 'file',
    description: 'Streaming proxy for ML model weights (same-origin, no base64)',
  },
];

/** Only ORT artifact file names — never nested paths. Blocks traversal. */
const ML_RUNTIME_FILE = /^[A-Za-z0-9._-]+\.(wasm|mjs|js)$/;

export async function handleMlRuntimeRoutes(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname.startsWith('/api/ml-runtime/')) {
    return serveRuntimeArtifact(req, url);
  }
  if (url.pathname === '/api/ml-weights') {
    return proxyWeights(req, url);
  }
  return null;
}

// ── Static runtime artifacts ─────────────────────────────────────────────────

async function serveRuntimeArtifact(req: Request, url: URL): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD')
    return errorResponse('Method not allowed', 405);

  const dir = getMlRuntimeDir();
  if (!dir) return errorResponse('ML runtime not available', 404);

  // Take only the final path segment and validate it — no directory traversal.
  const name = basename(decodeURIComponent(url.pathname.slice('/api/ml-runtime/'.length)));
  if (!ML_RUNTIME_FILE.test(name)) return errorResponse('Invalid runtime file', 400);

  const file = Bun.file(join(dir, name));
  if (!(await file.exists())) return errorResponse('Not found', 404);

  const ext = extname(name).toLowerCase();
  const contentType =
    ext === '.wasm'
      ? 'application/wasm'
      : ext === '.mjs' || ext === '.js'
        ? 'application/javascript'
        : MIME_TYPES[ext] || 'application/octet-stream';

  return new Response(req.method === 'HEAD' ? null : file, {
    headers: {
      'Content-Type': contentType,
      // HEAD sends a null body; report the real size so size probes work.
      'Content-Length': String(file.size),
      // Artifacts are versioned with the onnxruntime-web package — safe to cache hard.
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}

// ── Streaming weights proxy ──────────────────────────────────────────────────

async function proxyWeights(req: Request, url: URL): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD')
    return errorResponse('Method not allowed', 405);

  const target = url.searchParams.get('url');
  if (!target) return errorResponse('Missing "url" query parameter', 400);

  // SSRF guard (scheme + private-network block).
  try {
    validateUrl(target);
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : 'Invalid URL', 400);
  }

  // Domain allowlist — do not silently exfiltrate to arbitrary hosts.
  const domain = extractDomain(target);
  if (!(await isDomainAllowed(domain))) {
    return errorResponse(
      `Domain "${domain}" is not allowed. Add it to config/curl_allowed_domains.yaml ` +
        `(or set allow_all_domains: true) to download weights from it.`,
      403,
    );
  }

  // Forward Range so browsers can resume/segment large downloads.
  const range = req.headers.get('range');
  const upstreamHeaders: Record<string, string> = {};
  if (range) upstreamHeaders['Range'] = range;

  let upstream: Response;
  try {
    upstream = await safeFetch(target, { method: 'GET', headers: upstreamHeaders });
  } catch (err) {
    return errorResponse(
      `Failed to fetch weights: ${err instanceof Error ? err.message : String(err)}`,
      502,
    );
  }

  if (!upstream.ok && upstream.status !== 206) {
    return errorResponse(`Upstream returned ${upstream.status} ${upstream.statusText}`, 502);
  }

  // Stream the body straight through — no buffering, no base64.
  const headers: Record<string, string> = {
    'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'Access-Control-Expose-Headers': 'Content-Length, ETag, Accept-Ranges, Content-Range',
  };
  for (const h of ['content-length', 'etag', 'accept-ranges', 'content-range', 'last-modified']) {
    const v = upstream.headers.get(h);
    if (v) headers[h] = v;
  }

  return new Response(req.method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    headers,
  });
}
