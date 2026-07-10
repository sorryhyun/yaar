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
 *   `storage/`, resuming a partial `.part` via Range. Multi-GB weights can't go
 *   through `POST /api/storage/{path}` (capped at MAX_UPLOAD_SIZE), so the server
 *   pulls them itself; the app then reads them same-origin off `/api/storage/…`.
 * - `GET /api/ml-weights/download?dest=<path>` — progress for the above.
 */

import { join, basename, extname, dirname } from 'path';
import { createWriteStream } from 'fs';
import { mkdir, stat, rename } from 'fs/promises';
import { once } from 'events';
import { getMlRuntimeDir, MIME_TYPES } from '../../config.js';
import { errorResponse, jsonResponse, type EndpointMeta } from '../utils.js';
import { validateUrl, safeFetch } from '../../lib/ssrf.js';
import { extractDomain, isDomainAllowed } from '../../features/config/domains.js';
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
  if (url.pathname.startsWith('/api/ml-runtime/')) {
    return serveRuntimeArtifact(req, url);
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
  let body: { url?: string; dest?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }
  const target = body.url ?? '';
  const dest = body.dest ?? '';

  try {
    validateUrl(target);
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : 'Invalid URL', 400);
  }
  const domain = extractDomain(target);
  if (!(await isDomainAllowed(domain))) {
    return errorResponse(`Domain "${domain}" is not allowed`, 403);
  }
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
    job.error = err instanceof Error ? err.message : String(err);
  });
  return jsonResponse({ dest, ...job });
}

async function runDownload(target: string, abs: string, job: DownloadJob): Promise<void> {
  const part = `${abs}.part`;
  await mkdir(dirname(abs), { recursive: true });

  // Resume: ask for the remainder of a previous partial transfer.
  const from = await fileSize(part);
  const headers: Record<string, string> = {};
  if (from > 0) headers['Range'] = `bytes=${from}-`;

  const res = await safeFetch(target, { method: 'GET', headers });
  if (!res.ok && res.status !== 206) {
    throw new Error(`Upstream returned ${res.status} ${res.statusText}`);
  }
  // A 200 to a Range request means the server ignored it — restart from zero.
  const resuming = res.status === 206 && from > 0;
  const base = resuming ? from : 0;
  job.loaded = base;
  job.total = base + Number(res.headers.get('content-length') || 0);
  if (!res.body) throw new Error('Upstream sent no body');

  const out = createWriteStream(part, { flags: resuming ? 'a' : 'w' });
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // Respect backpressure — a 3.9 GB file will outrun the disk otherwise.
      if (!out.write(value)) await once(out, 'drain');
      job.loaded += value.byteLength;
    }
  } finally {
    out.end();
  }
  await once(out, 'finish');
  // Publish atomically: readers never observe a half-written weight file.
  await rename(part, abs);
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
