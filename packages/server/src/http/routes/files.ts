/**
 * File-serving routes — PDF render, sandbox, app static, storage files.
 */

import { join, extname } from 'path';
import { renderPdfPage } from '../../lib/pdf/index.js';
import { PROJECT_ROOT, MIME_TYPES, MAX_UPLOAD_SIZE } from '../../config.js';
import { errorResponse, jsonResponse, safePath, type EndpointMeta } from '../utils.js';
import { resolvePath } from '../../storage/storage-manager.js';
import { parseContentPath } from '@yaar/shared';

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
  // Serve browser screenshot
  // URL format: /api/browser/{sessionId}/screenshot
  const browserScreenshotMatch = url.pathname.match(
    /^\/api\/browser\/([a-zA-Z0-9_-]+)\/screenshot$/,
  );
  if (browserScreenshotMatch && req.method === 'GET') {
    const sessionId = decodeURIComponent(browserScreenshotMatch[1]);
    try {
      const { getBrowserPool } = await import('../../lib/browser/index.js');
      const session = getBrowserPool().getSession(sessionId);
      if (!session) {
        return errorResponse('Browser session not found', 404);
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
  // URL format: /api/browser/{sessionId}/events
  const browserEventsMatch = url.pathname.match(/^\/api\/browser\/([a-zA-Z0-9_-]+)\/events$/);
  if (browserEventsMatch && req.method === 'GET') {
    const sessionId = decodeURIComponent(browserEventsMatch[1]);
    try {
      const { getBrowserPool } = await import('../../lib/browser/index.js');
      const session = getBrowserPool().getSession(sessionId);
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

  // Serve sandbox files (for previewing compiled apps)
  const sandboxParsed =
    url.pathname.startsWith('/api/sandbox/') && req.method === 'GET'
      ? parseContentPath(decodeURIComponent(url.pathname))
      : null;
  if (sandboxParsed?.authority === 'sandbox' && sandboxParsed.sandboxId && sandboxParsed.path) {
    const sandboxId = sandboxParsed.sandboxId;
    const filePath = sandboxParsed.path;

    const sandboxDir = join(PROJECT_ROOT, 'sandbox', sandboxId);
    const normalizedPath = safePath(sandboxDir, filePath);
    if (!normalizedPath) {
      return errorResponse('Access denied', 403);
    }

    try {
      const content = Buffer.from(await Bun.file(normalizedPath).arrayBuffer());
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

  // Serve app static files (for deployed apps)
  const appParsed = url.pathname.startsWith('/api/apps/')
    ? parseContentPath(decodeURIComponent(url.pathname))
    : null;
  if (appParsed?.authority === 'apps' && req.method === 'GET') {
    const appId = appParsed.appId;
    const filePath = appParsed.path;

    const appsDir = join(PROJECT_ROOT, 'apps', appId);
    const normalizedPath = safePath(appsDir, filePath);
    if (!normalizedPath) {
      return errorResponse('Access denied', 403);
    }

    try {
      const content = Buffer.from(await Bun.file(normalizedPath).arrayBuffer());
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

  // Storage API — GET (read/list), POST (write), DELETE
  const storageParsed = url.pathname.startsWith('/api/storage/')
    ? parseContentPath(decodeURIComponent(url.pathname))
    : null;
  if (storageParsed?.authority === 'storage') {
    const filePath = storageParsed.path;

    const resolved = resolvePath(filePath);
    if (!resolved) {
      return errorResponse('Access denied', 403);
    }

    // GET — serve file or list directory
    if (req.method === 'GET') {
      // Directory listing mode
      if (url.searchParams.get('list') === 'true') {
        const result = await storageList(filePath);
        if (!result.success) {
          return errorResponse(result.error ?? 'List failed');
        }
        return jsonResponse(result.entries);
      }

      // Serve file (zero-copy via Bun.file())
      try {
        const file = Bun.file(resolved.absolutePath);
        if (!(await file.exists())) {
          return errorResponse('File not found', 404);
        }
        const ext = extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        return new Response(file, {
          headers: {
            'Content-Type': contentType,
            'Cache-Control': 'no-cache',
          },
        });
      } catch {
        return errorResponse('File not found', 404);
      }
    }

    // POST — write file
    if (req.method === 'POST') {
      if (resolved.readOnly) {
        return errorResponse('Mount is read-only', 403);
      }
      try {
        const body = await req.arrayBuffer();
        if (body.byteLength > MAX_UPLOAD_SIZE) {
          return errorResponse(`Request body too large (max ${MAX_UPLOAD_SIZE} bytes)`, 413);
        }
        const result = await storageWrite(filePath, Buffer.from(body));
        if (!result.success) {
          return errorResponse(result.error ?? 'Write failed');
        }
        return jsonResponse({ ok: true, path: result.path });
      } catch {
        return errorResponse('Write failed');
      }
    }

    // DELETE — remove file
    if (req.method === 'DELETE') {
      if (resolved.readOnly) {
        return errorResponse('Mount is read-only', 403);
      }
      const result = await storageDelete(filePath);
      if (!result.success) {
        return errorResponse(result.error ?? 'Delete failed');
      }
      return jsonResponse({ ok: true, path: result.path });
    }
  }

  return null;
}
