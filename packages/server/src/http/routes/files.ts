/**
 * File-serving routes — PDF render, sandbox, app static, storage files.
 */

import { join, extname } from 'path';
import { renderPdfPage } from '../../lib/pdf/index.js';
import { PROJECT_ROOT, MIME_TYPES, MAX_UPLOAD_SIZE } from '../../config.js';
import { errorResponse, jsonResponse, safePathAsync, type EndpointMeta } from '../utils.js';
import { readBodyWithLimit, BodyTooLargeError } from '../body-limit.js';
import { resolvePath } from '../../storage/storage-manager.js';
import { parseContentPath, type ParsedContentPath } from '@yaar/shared';

export const PUBLIC_ENDPOINTS: EndpointMeta[] = [
  {
    method: 'GET',
    path: '/api/apps/{appId}/{path}',
    response: 'file',
    description: 'App static files',
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
    method: 'DELETE',
    path: '/api/storage/{path}',
    response: 'JSON',
    description: 'Delete a storage file',
  },
  {
    method: 'GET',
    path: '/api/pdf/{path}/{page}',
    response: 'image/png',
    description: 'Render PDF page as PNG',
  },
  {
    method: 'GET',
    path: '/api/browser/sessions',
    response: 'JSON',
    description: 'List active browser sessions',
  },
  {
    method: 'POST',
    path: '/api/browser/{browserId}/navigate',
    response: 'JSON',
    description: 'Navigate a browser directly (bypass agent)',
  },
  {
    method: 'GET',
    path: '/api/sandbox/{sandboxId}/{path}',
    response: 'file',
    description: 'Serve sandbox files',
  },
];
import { storageWrite, storageDelete, storageList } from '../../storage/storage-manager.js';

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

export async function handleFileRoutes(req: Request, url: URL): Promise<Response | null> {
  // List active browser sessions
  // URL format: GET /api/browser/sessions
  if (url.pathname === '/api/browser/sessions' && req.method === 'GET') {
    try {
      const { getBrowserPool } = await import('../../lib/browser/index.js');
      const browsers = getBrowserPool().getAllSessions();
      const result = [...browsers.entries()].map(([browserId, session]) => ({
        browserId,
        url: session.currentUrl,
        title: session.currentTitle,
        windowId: session.windowId,
      }));
      return jsonResponse(result);
    } catch {
      return jsonResponse([]);
    }
  }

  // Direct browser navigation (bypass agent)
  // URL format: POST /api/browser/{browserId}/navigate
  const browserNavMatch = url.pathname.match(/^\/api\/browser\/([a-zA-Z0-9_-]+)\/navigate$/);
  if (browserNavMatch && req.method === 'POST') {
    const browserId = decodeURIComponent(browserNavMatch[1]);
    try {
      const body = (await req.json()) as { url?: string };
      if (!body.url || typeof body.url !== 'string') {
        return errorResponse('Missing "url" in request body', 400);
      }

      // Validate URL
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(body.url);
      } catch {
        return errorResponse('Invalid URL', 400);
      }
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        return errorResponse('Only http/https URLs are allowed', 400);
      }

      // Check domain allowlist
      const { isDomainAllowed, extractDomain } = await import('../../features/config/domains.js');
      const domain = extractDomain(body.url);
      if (!domain) return errorResponse('Invalid URL', 400);
      if (!(await isDomainAllowed(domain))) {
        return errorResponse(`Domain "${domain}" not allowed`, 403);
      }

      const { getBrowserPool } = await import('../../lib/browser/index.js');
      const session = getBrowserPool().getSession(browserId);
      if (!session) {
        return errorResponse('Browser not found', 404);
      }

      const state = await session.navigate(body.url);
      return jsonResponse({
        ok: true,
        url: state.url,
        title: state.title,
      });
    } catch (err) {
      return errorResponse(
        `Navigation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Serve browser screenshot
  // URL format: /api/browser/{browserId}/screenshot
  const browserScreenshotMatch = url.pathname.match(
    /^\/api\/browser\/([a-zA-Z0-9_-]+)\/screenshot$/,
  );
  if (browserScreenshotMatch && req.method === 'GET') {
    const browserId = decodeURIComponent(browserScreenshotMatch[1]);
    try {
      const { getBrowserPool } = await import('../../lib/browser/index.js');
      const session = getBrowserPool().getSession(browserId);
      if (!session) {
        return errorResponse('Browser not found', 404);
      }
      const fresh = url.searchParams.has('fresh');
      const buf = fresh ? await session.screenshot() : session.lastScreenshot;
      if (!buf) {
        return errorResponse('No screenshot available', 404);
      }
      return new Response(buf, {
        headers: {
          'Content-Type': 'image/webp',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Content-Length': buf.length.toString(),
        },
      });
    } catch {
      return errorResponse('Browser not available', 404);
    }
  }

  // SSE stream for browser session updates
  // URL format: /api/browser/{browserId}/events
  const browserEventsMatch = url.pathname.match(/^\/api\/browser\/([a-zA-Z0-9_-]+)\/events$/);
  if (browserEventsMatch && req.method === 'GET') {
    const browserId = decodeURIComponent(browserEventsMatch[1]);
    try {
      const { getBrowserPool } = await import('../../lib/browser/index.js');
      const session = getBrowserPool().getSession(browserId);
      if (!session) {
        return errorResponse('Browser session not found', 404);
      }

      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          const write = (data: string) => {
            try {
              controller.enqueue(encoder.encode(data));
            } catch {
              // Stream closed
              cleanup();
            }
          };

          // Send current state immediately so the client doesn't miss anything
          const initial = JSON.stringify({
            url: session.currentUrl,
            title: session.currentTitle,
            version: session.version,
          });
          write(`data: ${initial}\n\n`);

          const cleanup = () => {
            clearInterval(heartbeat);
            session.off('updated', onUpdate);
            session.off('closed', onClosed);
          };

          // Stream subsequent updates
          const onUpdate = (update: { url: string; title: string; version: number }) => {
            write(`data: ${JSON.stringify(update)}\n\n`);
          };
          const onClosed = () => {
            cleanup();
            try {
              controller.close();
            } catch {
              // Already closed
            }
          };

          // Keep connection alive through proxies
          const heartbeat = setInterval(() => {
            write(': heartbeat\n\n');
          }, 30_000);

          session.on('updated', onUpdate);
          session.on('closed', onClosed);

          // Clean up when the client disconnects
          req.signal.addEventListener('abort', cleanup);
        },
      });

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch {
      return errorResponse('Browser not available', 404);
    }
  }

  // Render PDF page as image
  // URL format: /api/pdf/<path>/<page> (e.g., /api/pdf/documents/paper.pdf/1)
  const pdfMatch = url.pathname.match(/^\/api\/pdf\/(.+)\/(\d+)$/);
  if (pdfMatch && req.method === 'GET') {
    const pdfPath = decodeURIComponent(pdfMatch[1]);
    const pageNum = parseInt(pdfMatch[2], 10);

    const resolved = resolvePath(pdfPath);
    if (!resolved) {
      return errorResponse('Access denied', 403);
    }
    const normalizedPath = resolved.absolutePath;

    if (extname(pdfPath).toLowerCase() !== '.pdf') {
      return errorResponse('Not a PDF file', 400);
    }

    try {
      const pngBuffer = await renderPdfPage(normalizedPath, pageNum, 1.5);
      return new Response(pngBuffer, {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=3600',
        },
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Unknown error';
      if (error.includes('Failed to render page')) {
        return errorResponse(error, 404);
      } else {
        return errorResponse('Failed to render PDF page');
      }
    }
  }

  // Content routes — sandbox, apps, storage (unified via parseContentPath)
  const parsed = parseContentPath(decodeURIComponent(url.pathname));
  if (parsed) {
    switch (parsed.authority) {
      case 'sandbox':
        return handleSandbox(req, parsed);
      case 'apps':
        return handleApps(req, parsed);
      case 'storage':
        return handleStorage(req, url, parsed);
    }
  }

  return null;
}

/** Serve sandbox files (for previewing compiled apps). */
async function handleSandbox(
  req: Request,
  parsed: Extract<ParsedContentPath, { authority: 'sandbox' }>,
): Promise<Response | null> {
  if (req.method !== 'GET' || !parsed.sandboxId || !parsed.path) return null;

  const sandboxDir = join(PROJECT_ROOT, 'sandbox', parsed.sandboxId);
  const normalizedPath = await safePathAsync(sandboxDir, parsed.path);
  if (!normalizedPath) return errorResponse('Access denied', 403);

  return serveStaticFile(req, normalizedPath, parsed.path);
}

/** Serve app static files (for deployed apps). */
async function handleApps(
  req: Request,
  parsed: Extract<ParsedContentPath, { authority: 'apps' }>,
): Promise<Response | null> {
  if (req.method !== 'GET') return null;

  const appsDir = join(PROJECT_ROOT, 'apps', parsed.appId);
  const normalizedPath = await safePathAsync(appsDir, parsed.path);
  if (!normalizedPath) return errorResponse('Access denied', 403);

  return serveStaticFile(req, normalizedPath, parsed.path);
}

/** Storage API — GET (read/list), POST (write), DELETE. */
async function handleStorage(
  req: Request,
  url: URL,
  parsed: Extract<ParsedContentPath, { authority: 'storage' }>,
): Promise<Response | null> {
  const filePath = parsed.path;
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
      const buf = await readBodyWithLimit(req, MAX_UPLOAD_SIZE);
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
      headers['Content-Security-Policy'] = "connect-src 'self'";
    }
    const body = maybeGzip(req, headers, content);
    return new Response(body, { headers });
  } catch {
    return errorResponse('File not found', 404);
  }
}
