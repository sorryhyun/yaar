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
 * - `POST /api/ml-weights/download` — stream a remote weight file to disk under
 *   `storage/` using parallel Range requests, resuming a partial `.part` chunk by
 *   chunk. Multi-GB weights can't go through `POST /api/storage/{path}` (capped at
 *   MAX_UPLOAD_SIZE), so the server pulls them itself; the app then reads them
 *   same-origin off `/api/storage/…`.
 * - `GET /api/ml-weights/download?dest=<path>` — progress for the above.
 */

import { basename, extname } from 'path';
import { stat } from 'fs/promises';
import { getMlRuntimeArtifact, MIME_TYPES } from '../../config.js';
import { errorResponse, jsonResponse, parseJsonBody, type EndpointMeta } from '../utils.js';
import { requireBundle, resolvePrincipal } from '../access.js';
import { validateUrl, safeFetch } from '../../lib/ssrf.js';
import { errMessage } from '../../lib/errors.js';
import { downloadToFile } from '../../lib/download/chunked.js';
import { ensureDomainAllowed } from '../../features/http/domain-gate.js';
import { extractDomain } from '../../features/config/domains.js';
import { resolvePath } from '../../storage/storage-manager.js';

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
  {
    method: 'POST',
    path: '/api/ml-weights/download',
    response: 'JSON',
    description: 'Download a weight file to storage/. Body: `{ url, dest }`. Resumable.',
  },
  {
    method: 'GET',
    path: '/api/ml-weights/download?dest={path}',
    response: 'JSON',
    description: 'Progress of a weight download: `{ state, loaded, total }`',
  },
];

/** Only ORT artifact file names — never nested paths. Blocks traversal. */
const ML_RUNTIME_FILE = /^[A-Za-z0-9._-]+\.(wasm|mjs|js)$/;

export async function handleMlRuntimeRoutes(req: Request, url: URL): Promise<Response | null> {
  // The ORT runtime artifacts are inert binaries, name-checked against traversal, and
  // onnxruntime loads them itself (ort.env.wasm.wasmPaths) with no way to attach a
  // token. They stay open — there is nothing behind them to protect.
  if (url.pathname.startsWith('/api/ml-runtime/')) {
    return serveRuntimeArtifact(req, url);
  }

  // The weight routes are a different matter: they fetch an attacker-nameable URL and
  // stream the result to a path under storage. `yaar-ml` is what declares an app needs
  // that, so `yaar-ml` is what it takes to reach it.
  const weightRoute =
    url.pathname === '/api/ml-weights' || url.pathname === '/api/ml-weights/download';
  if (weightRoute) {
    const principal = resolvePrincipal(req, url);
    if (principal instanceof Response) return principal;
    const denied = requireBundle(principal, 'yaar-ml');
    if (denied) return denied;
  }

  if (url.pathname === '/api/ml-weights/download') {
    if (req.method === 'POST') return startDownload(req);
    if (req.method === 'GET') return downloadStatus(url);
    return errorResponse('Method not allowed', 405);
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

  // Take only the final path segment and validate it — no directory traversal.
  const name = basename(decodeURIComponent(url.pathname.slice('/api/ml-runtime/'.length)));
  if (!ML_RUNTIME_FILE.test(name)) return errorResponse('Invalid runtime file', 400);

  // Resolve per artifact, not per directory: a bundled exe carries these inside itself
  // and has no directory to point at.
  const path = getMlRuntimeArtifact(name);
  if (!path) return errorResponse('ML runtime not available', 404);

  const file = Bun.file(path);
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

  // Domain allowlist — do not silently exfiltrate to arbitrary hosts. An unknown domain
  // is a question for the user, not a 403: on a fresh install the allowlist is empty, and
  // refusing outright left the app dead with no way to consent.
  const denial = await ensureDomainAllowed(target, {
    purpose: `An app wants to load model weights from "${extractDomain(target)}".`,
  });
  if (denial) return errorResponse(denial.message, 403);

  // Forward Range so browsers can resume/segment large downloads.
  const range = req.headers.get('range');
  const upstreamHeaders: Record<string, string> = {};
  if (range) upstreamHeaders['Range'] = range;

  let upstream: Response;
  try {
    upstream = await safeFetch(target, { method: 'GET', headers: upstreamHeaders });
  } catch (err) {
    return errorResponse(`Failed to fetch weights: ${errMessage(err)}`, 502);
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

// ── Server-side weight download (HF → storage/) ──────────────────────────────
//
// The browser cannot write these files: `POST /api/storage/{path}` reads the whole
// body into memory under MAX_UPLOAD_SIZE (50 MB), and the DiT sidecar alone is
// 3.9 GB. So the server streams the download to disk itself and the app reads the
// result back through the ordinary `GET /api/storage/…` file route, which serves
// straight from disk via `Bun.file` at any size.

type DownloadState = 'downloading' | 'done' | 'error';
interface DownloadJob {
  state: DownloadState;
  loaded: number;
  total: number;
  error?: string;
}

/** Keyed by the cleaned `dest` path. Survives for the process lifetime. */
const downloads = new Map<string, DownloadJob>();

/** Resolve `dest` inside storage/, refusing traversal and read-only mounts. */
function resolveWritableDest(dest: string): { abs: string } | { error: Response } {
  if (!dest) return { error: errorResponse('Missing "dest"', 400) };
  const resolved = resolvePath(dest);
  if (!resolved) return { error: errorResponse('Access denied', 403) };
  if (resolved.readOnly) return { error: errorResponse('Destination is read-only', 403) };
  return { abs: resolved.absolutePath };
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function startDownload(req: Request): Promise<Response> {
  const body = await parseJsonBody<{ url?: string; dest?: string }>(req);
  if (body instanceof Response) return body;
  const target = body.url ?? '';
  const dest = body.dest ?? '';

  try {
    validateUrl(target);
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : 'Invalid URL', 400);
  }
  // Ask before refusing. This is the route a model download actually travels, and the
  // very first thing a fresh install does with it is name a domain nobody has approved.
  const denial = await ensureDomainAllowed(target, {
    purpose:
      `An app wants to download model weights from "${extractDomain(target)}" ` +
      `to this machine's storage.`,
  });
  if (denial) return errorResponse(denial.message, 403);

  const r = resolveWritableDest(dest);
  if ('error' in r) return r.error;

  // Already complete, or already running — don't start a second writer.
  const existing = downloads.get(dest);
  if (existing?.state === 'downloading') return jsonResponse({ dest, ...existing });
  const done = await fileSize(r.abs);
  if (done > 0) {
    const job: DownloadJob = { state: 'done', loaded: done, total: done };
    downloads.set(dest, job);
    return jsonResponse({ dest, ...job });
  }

  const job: DownloadJob = { state: 'downloading', loaded: 0, total: 0 };
  downloads.set(dest, job);
  // Detached: the client polls GET for progress rather than holding a request open
  // for a multi-GB transfer.
  void runDownload(target, r.abs, job).catch((err) => {
    job.state = 'error';
    job.error = errMessage(err);
  });
  return jsonResponse({ dest, ...job });
}

async function runDownload(target: string, abs: string, job: DownloadJob): Promise<void> {
  // Range-parallel: a single stream to the HF CDN caps near 40 MB/s, eight
  // concurrent chunks reach ~62 MB/s. Resume is handled per chunk, and the
  // downloader renames `.part` into place only once every chunk has landed.
  await downloadToFile(target, abs, {
    onProgress: (loaded, total) => {
      job.loaded = loaded;
      job.total = total;
    },
  });
  job.state = 'done';
  job.total = job.loaded;
}

function downloadStatus(url: URL): Response {
  const dest = url.searchParams.get('dest') ?? '';
  const r = resolveWritableDest(dest);
  if ('error' in r) return r.error;
  const job = downloads.get(dest);
  if (job) return jsonResponse({ dest, ...job });
  return jsonResponse({ dest, state: 'idle', loaded: 0, total: 0 });
}
