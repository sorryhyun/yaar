/**
 * File-serving routes — PDF render, app static, storage files.
 */

import { extname } from 'path';
import { getPdfInfo, PopplerNotInstalledError, renderPdfPage } from '../../features/pdf.js';
import { MIME_TYPES, MAX_UPLOAD_SIZE } from '../../config.js';
import { errorResponse, jsonResponse, safePathAsync, type EndpointMeta } from '../utils.js';
import { readBodyWithLimit, BodyTooLargeError } from '../body-limit.js';
import { appHtmlCsp } from '../csp.js';
import { resolvePath } from '../../storage/storage-manager.js';
import { resolveAppDir } from '../../features/apps/roots.js';
import { parseContentPath, type ParsedContentPath } from '../../lib/yaar-uri-server.js';
import {
  expandSelfPath,
  requirePermission,
  resolvePrincipal,
  storageUriFor,
  type Principal,
} from '../access.js';
import type { Verb } from '../../handlers/uri-registry.js';

export const PUBLIC_ENDPOINTS: EndpointMeta[] = [
  {
    method: 'GET',
    path: '/api/apps/{appId}/{path}',
    response: 'file',
    description: 'App static files',
  },
  {
    method: 'GET',
    path: '/api/storage',
    response: 'JSON',
    description: 'Storage root (list/read)',
  },
  {
    method: 'GET',
    path: '/api/storage/{path}',
    response: 'file',
    description: 'Read a storage file',
  },
  {
    method: 'GET',
    path: '/api/storage/{path}?list=true',
    response: 'JSON',
    description: 'List directory contents',
  },
  {
    method: 'POST',
    path: '/api/storage/{path}',
    response: 'JSON',
    description: 'Write a storage file (body = file content)',
  },
  {
    method: 'POST',
    path: '/api/storage/{path}?append=true',
    response: 'JSON',
    description: 'Append the body to a storage file, creating it if absent; answers its new size',
  },
  {
    method: 'DELETE',
    path: '/api/storage/{path}',
    response: 'JSON',
    description: 'Delete a storage file',
  },
  {
    method: 'GET',
    path: '/api/pdf/{path}',
    response: 'JSON',
    description: 'PDF page count and first-page size',
  },
  {
    method: 'GET',
    path: '/api/pdf/{path}/{page}',
    response: 'image/png',
    description: 'Render PDF page as PNG (?scale=, default 1.5)',
  },
];
import {
  storageAppend,
  storageWrite,
  storageDelete,
  storageList,
} from '../../storage/storage-manager.js';

/** Content types eligible for gzip compression. */
const COMPRESSIBLE = new Set([
  'text/html',
  'text/css',
  'text/javascript',
  'application/javascript',
  'application/json',
]);

/** Gzip-compress a buffer if the client accepts it and the content type is compressible. */
function maybeGzip(
  req: Request,
  headers: Record<string, string>,
  body: Buffer,
): Buffer | Uint8Array {
  const contentType = headers['Content-Type']?.split(';')[0];
  if (!contentType || !COMPRESSIBLE.has(contentType)) return body;
  if (body.length < 256) return body; // not worth compressing tiny responses
  const accept = req.headers.get('accept-encoding') ?? '';
  if (!accept.includes('gzip')) return body;
  headers['Content-Encoding'] = 'gzip';
  return Bun.gzipSync(new Uint8Array(body));
}

/**
 * Raster scale bounds for `/api/pdf/{path}/{page}?scale=` (1 = 72 DPI). The ceiling is
 * what a phone needs to keep a zoomed page sharp; past it one page is tens of megabytes
 * of bitmap for whoever asked.
 */
const PDF_SCALE_MIN = 0.5;
const PDF_SCALE_MAX = 4;
const PDF_SCALE_DEFAULT = 1.5;

/** The requested scale, the default when none was given, or `null` for one out of range. */
function pdfScale(raw: string | null): number | null {
  if (raw === null) return PDF_SCALE_DEFAULT;
  const scale = Number(raw);
  return raw.trim() !== '' && scale >= PDF_SCALE_MIN && scale <= PDF_SCALE_MAX ? scale : null;
}

/** The path prefixes this file owns. Anything else belongs to a later handler. */
function ownsPath(pathname: string): boolean {
  return (
    pathname.startsWith('/api/pdf/') ||
    pathname.startsWith('/api/apps/') ||
    pathname.startsWith('/api/storage')
  );
}

export async function handleFileRoutes(req: Request, url: URL): Promise<Response | null> {
  // Claim the path *before* resolving the caller. This handler runs just ahead of
  // static.ts, so it sees every frontend asset request on its way past — and
  // `resolvePrincipal` refuses a token-less request that carries the app origin. A
  // principal resolved for a path this file doesn't own turned that refusal into a
  // 403 on public frontend assets: an origin-isolated app (any `source:'user'` app,
  // served from 127.0.0.1) fetches `/NanumSquareNeoOTF-Rg.otf` for the @font-face
  // block the compiler injects, a CSS-initiated font fetch cannot attach an iframe
  // token, and the font 403'd instead of falling through to static.ts — which serves
  // it unauthenticated by design (`isStaticAsset`).
  if (!ownsPath(url.pathname)) return null;

  const principal = resolvePrincipal(req, url);
  if (principal instanceof Response) return principal;

  // PDF pages as images, and the page count a viewer needs before asking for any.
  //   /api/pdf/<path>          -> { pages, pageSize? }
  //   /api/pdf/<path>/<page>   -> image/png   (e.g. /api/pdf/documents/paper.pdf/1)
  if (url.pathname.startsWith('/api/pdf/') && req.method === 'GET') {
    const rest = url.pathname.slice('/api/pdf/'.length);
    const pageMatch = rest.match(/^(.+)\/(\d+)$/);
    const requested = decodeURIComponent(pageMatch ? pageMatch[1] : rest);

    // Rendering a page of a PDF is reading the file. Same gate as reading it, and the
    // same `self` expansion, so a storage URL and its raster name one file.
    const pdfUri = storageUriFor(principal, requested);
    if (pdfUri instanceof Response) return pdfUri;
    const denied = requirePermission(principal, pdfUri, 'read');
    if (denied) return denied;

    const pdfPath = expandSelfPath(
      requested,
      principal.kind === 'app' ? principal.appId : undefined,
    );
    const resolved = resolvePath(pdfPath);
    if (!resolved) {
      return errorResponse('Access denied', 403);
    }
    const normalizedPath = resolved.absolutePath;

    if (extname(pdfPath).toLowerCase() !== '.pdf') {
      return errorResponse('Not a PDF file', 400);
    }

    try {
      if (!pageMatch) {
        if (!(await Bun.file(normalizedPath).exists())) return errorResponse('File not found', 404);
        return jsonResponse(await getPdfInfo(normalizedPath));
      }

      const scale = pdfScale(url.searchParams.get('scale'));
      if (scale === null) {
        return errorResponse(
          `scale must be a number from ${PDF_SCALE_MIN} to ${PDF_SCALE_MAX}`,
          400,
        );
      }
      const pngBuffer = await renderPdfPage(normalizedPath, parseInt(pageMatch[2], 10), scale);
      return new Response(pngBuffer, {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=3600',
        },
      });
    } catch (err) {
      // Its own status and its own sentence: "install poppler" is something the reader
      // can act on, and it was arriving as a bare "Failed to render PDF page".
      if (err instanceof PopplerNotInstalledError) return errorResponse(err.message, 501);
      const error = err instanceof Error ? err.message : 'Unknown error';
      if (error.includes('Failed to render page')) {
        return errorResponse(error, 404);
      }
      return errorResponse(pageMatch ? 'Failed to render PDF page' : 'Failed to read PDF');
    }
  }

  // Content routes — apps, storage (unified via parseContentPath)
  const parsed = parseContentPath(decodeURIComponent(url.pathname));
  if (parsed) {
    switch (parsed.authority) {
      case 'apps':
        return handleApps(req, parsed);
      case 'storage':
        return handleStorage(req, url, parsed, principal);
    }
  }

  return null;
}

/** The verb each storage method performs, in the vocabulary the permission model uses. */
function storageVerb(req: Request, url: URL): Verb | null {
  switch (req.method) {
    case 'GET':
      return url.searchParams.get('list') === 'true' ? 'list' : 'read';
    case 'POST':
      return 'invoke'; // write
    case 'DELETE':
      return 'delete';
    default:
      return null;
  }
}

/**
 * The query parameters a storage write or delete may carry: the two credentials
 * (`extractIframeToken`, remote mode's `extractToken`). The file is named by the URL
 * path and by nothing else, so any other parameter is a caller who thinks otherwise —
 * `POST /api/storage/upload?path=shared/x.png` wrote a file called `upload` and
 * answered `{ ok: true, path: 'upload' }`. Refusing it names the mistake.
 */
const MUTATION_QUERY_PARAMS = new Set(['__yaar_token', 'token']);

/**
 * `append=true` turns a write into an append (`storageAppend`). It changes how the bytes
 * land, never which file they land in, so it is the one non-credential parameter a write
 * takes — and only a write: a delete carrying it is as confused as one carrying `path`.
 */
const WRITE_QUERY_PARAMS = new Set([...MUTATION_QUERY_PARAMS, 'append']);

/** A 400 for a write or delete whose query string would be ignored, else `null`. */
function refuseStrayQuery(req: Request, url: URL): Response | null {
  if (req.method !== 'POST' && req.method !== 'DELETE') return null;
  const allowed = req.method === 'POST' ? WRITE_QUERY_PARAMS : MUTATION_QUERY_PARAMS;
  const stray = [...new Set(url.searchParams.keys())].filter((k) => !allowed.has(k));
  if (stray.length === 0) return null;
  return errorResponse(
    `Unsupported query parameter${stray.length > 1 ? 's' : ''} ${stray.map((k) => `'${k}'`).join(', ')} ` +
      `on ${req.method} /api/storage — the target file is the URL path (${req.method} /api/storage/{path}), ` +
      `nothing in the query names it.`,
    400,
  );
}

/** Serve app static files (for deployed apps). */
async function handleApps(
  req: Request,
  parsed: Extract<ParsedContentPath, { authority: 'apps' }>,
): Promise<Response | null> {
  if (req.method !== 'GET') return null;

  const appDir = resolveAppDir(parsed.appId);
  if (!appDir) return errorResponse('Not found', 404);
  const normalizedPath = await safePathAsync(appDir, parsed.path);
  if (!normalizedPath) return errorResponse('Access denied', 403);

  return serveStaticFile(req, normalizedPath, parsed.path);
}

/** Storage API — GET (read/list), POST (write), DELETE. */
async function handleStorage(
  req: Request,
  url: URL,
  parsed: Extract<ParsedContentPath, { authority: 'storage' }>,
  principal: Principal,
): Promise<Response | null> {
  const verb = storageVerb(req, url);
  if (!verb) return null;
  const stray = refuseStrayQuery(req, url);
  if (stray) return stray;

  // Name the resource in the permission model's own vocabulary, then ask. This also
  // resolves the `self` pronoun (`apps/self/`, `shared/self/`) against the calling app
  // and rejects traversal, so the URI is the one the app holds a permission for.
  const uri = storageUriFor(principal, parsed.path);
  if (uri instanceof Response) return uri;
  const denied = requirePermission(principal, uri, verb);
  if (denied) return denied;

  // The same expansion, on the path the bytes are actually read from and written to.
  // `storageUriFor` has already refused a `self` it could not expand, so this cannot
  // leave one standing — and sharing the function is what keeps the file checked and
  // the file touched from ever being two different files.
  const filePath = expandSelfPath(
    parsed.path,
    principal.kind === 'app' ? principal.appId : undefined,
  );

  const resolved = resolvePath(filePath);
  if (!resolved) return errorResponse('Access denied', 403);

  if (req.method === 'GET') {
    if (url.searchParams.get('list') === 'true') {
      const result = await storageList(filePath);
      if (!result.success) return errorResponse(result.error ?? 'List failed');
      return jsonResponse(result.entries);
    }

    try {
      const file = Bun.file(resolved.absolutePath);
      if (!(await file.exists())) return errorResponse('File not found', 404);
      const ext = extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      return new Response(file, {
        headers: { 'Content-Type': contentType, 'Cache-Control': 'no-cache' },
      });
    } catch {
      return errorResponse('File not found', 404);
    }
  }

  if (req.method === 'POST') {
    if (resolved.readOnly) return errorResponse('Mount is read-only', 403);
    try {
      const append = url.searchParams.get('append');
      if (append !== null && append !== 'true') {
        return errorResponse(`append must be 'true' when present, got '${append}'`, 400);
      }
      const buf = await readBodyWithLimit(req, MAX_UPLOAD_SIZE);
      if (append === 'true') {
        const result = await storageAppend(filePath, buf);
        if (!result.success) return errorResponse(result.error ?? 'Append failed');
        return jsonResponse({ ok: true, path: result.path, size: result.bytes });
      }
      const result = await storageWrite(filePath, buf);
      if (!result.success) return errorResponse(result.error ?? 'Write failed');
      return jsonResponse({ ok: true, path: result.path });
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        return errorResponse(`Request body too large (max ${MAX_UPLOAD_SIZE} bytes)`, 413);
      }
      return errorResponse('Write failed');
    }
  }

  if (req.method === 'DELETE') {
    if (resolved.readOnly) return errorResponse('Mount is read-only', 403);
    const result = await storageDelete(filePath);
    if (!result.success) return errorResponse(result.error ?? 'Delete failed');
    return jsonResponse({ ok: true, path: result.path });
  }

  return null;
}

/** Serve a static file with gzip and CSP for HTML. */
async function serveStaticFile(
  req: Request,
  absolutePath: string,
  filePath: string,
): Promise<Response> {
  try {
    const content = Buffer.from(await Bun.file(absolutePath).arrayBuffer());
    const ext = extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
    };
    if (ext === '.html') {
      headers['Content-Security-Policy'] = appHtmlCsp(req);
    }
    const body = maybeGzip(req, headers, content);
    return new Response(body, { headers });
  } catch {
    return errorResponse('File not found', 404);
  }
}
