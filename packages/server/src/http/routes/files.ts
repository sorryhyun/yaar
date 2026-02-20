/**
 * File-serving routes — PDF render, sandbox, app static, storage files.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { readFile, readdir } from 'fs/promises';
import { join, extname } from 'path';
import { gzip } from 'zlib';
import { promisify } from 'util';
import { renderPdfPage } from '../../lib/pdf/index.js';
import { PROJECT_ROOT, MIME_TYPES, MAX_UPLOAD_SIZE } from '../../config.js';
import { sendError, sendJson, safePath, type EndpointMeta } from '../utils.js';
import { resolvePath } from '../../storage/storage-manager.js';

export const PUBLIC_ENDPOINTS: EndpointMeta[] = [
  {
    method: 'GET',
    path: '/api/apps/{appId}/icon',
    response: 'image',
    description: 'App icon image',
  },
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

const gzipAsync = promisify(gzip);

/** Content types eligible for gzip compression. */
const COMPRESSIBLE = new Set([
  'text/html',
  'text/css',
  'text/javascript',
  'application/javascript',
  'application/json',
]);

/** Gzip-compress a buffer if the client accepts it and the content type is compressible. */
async function maybeGzip(
  req: IncomingMessage,
  headers: Record<string, string>,
  body: Buffer,
): Promise<Buffer> {
  const contentType = headers['Content-Type']?.split(';')[0];
  if (!contentType || !COMPRESSIBLE.has(contentType)) return body;
  if (body.length < 256) return body; // not worth compressing tiny responses
  const accept = req.headers['accept-encoding'] ?? '';
  if (!accept.includes('gzip')) return body;
  headers['Content-Encoding'] = 'gzip';
  return gzipAsync(body) as Promise<Buffer>;
}

/** Supported image extensions for app icons */
const ICON_IMAGE_EXTENSIONS = new Set(['.png', '.webp', '.jpg', '.jpeg', '.gif', '.svg']);

/**
 * Collect the full request body as a Buffer, enforcing a size limit.
 * Resolves with the Buffer, or rejects / sends 413 if exceeded.
 */
function collectBody(req: IncomingMessage, res: ServerResponse, maxSize: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxSize) {
        req.destroy();
        sendError(res, `Request body too large (max ${maxSize} bytes)`, 413);
        reject(new Error('Body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(err));
  });
}

export async function handleFileRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
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
        sendError(res, 'Browser session not found', 404);
        return true;
      }
      const fresh = url.searchParams.has('fresh');
      const buf = fresh ? await session.screenshot() : session.lastScreenshot;
      if (!buf) {
        sendError(res, 'No screenshot available', 404);
        return true;
      }
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Content-Length': buf.length.toString(),
      });
      res.end(buf);
    } catch {
      sendError(res, 'Browser not available', 404);
    }
    return true;
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
        sendError(res, 'Browser session not found', 404);
        return true;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      // Send current state immediately so the client doesn't miss anything
      const initial = JSON.stringify({
        url: session.currentUrl,
        title: session.currentTitle,
        version: session.version,
      });
      res.write(`data: ${initial}\n\n`);

      const cleanup = () => {
        clearInterval(heartbeat);
        session.off('updated', onUpdate);
        session.off('closed', onClosed);
      };

      // Stream subsequent updates
      const onUpdate = (update: { url: string; title: string; version: number }) => {
        if (res.destroyed) {
          cleanup();
          return;
        }
        res.write(`data: ${JSON.stringify(update)}\n\n`);
      };
      const onClosed = () => {
        if (!res.destroyed) res.end();
        cleanup();
      };

      // Keep connection alive through proxies
      const heartbeat = setInterval(() => {
        if (res.destroyed) {
          cleanup();
          return;
        }
        res.write(': heartbeat\n\n');
      }, 30_000);

      session.on('updated', onUpdate);
      session.on('closed', onClosed);
      req.on('close', cleanup);
    } catch {
      sendError(res, 'Browser not available', 404);
    }
    return true;
  }

  // Render PDF page as image
  // URL format: /api/pdf/<path>/<page> (e.g., /api/pdf/documents/paper.pdf/1)
  const pdfMatch = url.pathname.match(/^\/api\/pdf\/(.+)\/(\d+)$/);
  if (pdfMatch && req.method === 'GET') {
    const pdfPath = decodeURIComponent(pdfMatch[1]);
    const pageNum = parseInt(pdfMatch[2], 10);

    const resolved = resolvePath(pdfPath);
    if (!resolved) {
      sendError(res, 'Access denied', 403);
      return true;
    }
    const normalizedPath = resolved.absolutePath;

    if (extname(pdfPath).toLowerCase() !== '.pdf') {
      sendError(res, 'Not a PDF file', 400);
      return true;
    }

    try {
      const pngBuffer = await renderPdfPage(normalizedPath, pageNum, 1.5);
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=3600',
      });
      res.end(pngBuffer);
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Unknown error';
      if (error.includes('Failed to render page')) {
        sendError(res, error, 404);
      } else {
        sendError(res, 'Failed to render PDF page');
      }
    }
    return true;
  }

  // Serve sandbox files (for previewing compiled apps)
  // URL format: /api/sandbox/{sandboxId}/{path}
  const sandboxMatch = url.pathname.match(/^\/api\/sandbox\/(\d+)\/(.+)$/);
  if (sandboxMatch && req.method === 'GET') {
    const sandboxId = sandboxMatch[1];
    const filePath = decodeURIComponent(sandboxMatch[2]);

    const sandboxDir = join(PROJECT_ROOT, 'sandbox', sandboxId);
    const normalizedPath = safePath(sandboxDir, filePath);
    if (!normalizedPath) {
      sendError(res, 'Access denied', 403);
      return true;
    }

    try {
      const content = await readFile(normalizedPath);
      const ext = extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      const headers: Record<string, string> = {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache',
      };
      if (ext === '.html') {
        headers['Content-Security-Policy'] = "connect-src 'self'";
      }
      const body = await maybeGzip(req, headers, content);
      res.writeHead(200, headers);
      res.end(body);
    } catch {
      sendError(res, 'File not found', 404);
    }
    return true;
  }

  // Serve app icon image
  // URL format: /api/apps/{appId}/icon
  const appIconMatch = url.pathname.match(/^\/api\/apps\/([a-z][a-z0-9-]*)\/icon$/);
  if (appIconMatch && req.method === 'GET') {
    const appId = appIconMatch[1];
    const appDir = join(PROJECT_ROOT, 'apps', appId);

    const validated = safePath(PROJECT_ROOT, join('apps', appId));
    if (!validated) {
      sendError(res, 'Access denied', 403);
      return true;
    }

    try {
      const files = await readdir(appDir);
      let iconFile: string | undefined;
      for (const file of files) {
        const lower = file.toLowerCase();
        const dotIdx = lower.lastIndexOf('.');
        if (dotIdx === -1) continue;
        const baseName = lower.slice(0, dotIdx);
        const ext = lower.slice(dotIdx);
        if (baseName === 'icon' && ICON_IMAGE_EXTENSIONS.has(ext)) {
          iconFile = file;
          break;
        }
      }

      if (!iconFile) {
        sendError(res, 'Icon not found', 404);
        return true;
      }

      const iconPath = join(appDir, iconFile);
      const content = await readFile(iconPath);
      const ext = extname(iconFile).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
      });
      res.end(content);
    } catch {
      sendError(res, 'Icon not found', 404);
    }
    return true;
  }

  // Serve app static files (for deployed apps)
  // URL format: /api/apps/{appId}/{path} (also accepts /static/ or /dist/ prefix)
  const appStaticMatch = url.pathname.match(
    /^\/api\/apps\/([a-z][a-z0-9-]*)\/(?:(?:static|dist)\/)?(.+\..+)$/,
  );
  if (appStaticMatch && req.method === 'GET') {
    const appId = appStaticMatch[1];
    const filePath = decodeURIComponent(appStaticMatch[2]);

    const appsDir = join(PROJECT_ROOT, 'apps', appId);
    const normalizedPath = safePath(appsDir, filePath);
    if (!normalizedPath) {
      sendError(res, 'Access denied', 403);
      return true;
    }

    try {
      const content = await readFile(normalizedPath);
      const ext = extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      const headers: Record<string, string> = {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache',
      };
      if (ext === '.html') {
        headers['Content-Security-Policy'] = "connect-src 'self'";
      }
      const body = await maybeGzip(req, headers, content);
      res.writeHead(200, headers);
      res.end(body);
    } catch {
      sendError(res, 'File not found', 404);
    }
    return true;
  }

  // Storage API — GET (read/list), POST (write), DELETE
  if (url.pathname.startsWith('/api/storage/')) {
    const filePath = decodeURIComponent(url.pathname.slice('/api/storage/'.length));

    const resolved = resolvePath(filePath);
    if (!resolved) {
      sendError(res, 'Access denied', 403);
      return true;
    }

    // GET — serve file or list directory
    if (req.method === 'GET') {
      // Directory listing mode
      if (url.searchParams.get('list') === 'true') {
        const result = await storageList(filePath);
        if (!result.success) {
          sendError(res, result.error ?? 'List failed');
          return true;
        }
        sendJson(res, result.entries);
        return true;
      }

      // Serve file
      try {
        const content = await readFile(resolved.absolutePath);
        const ext = extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': 'no-cache',
        });
        res.end(content);
      } catch {
        sendError(res, 'File not found', 404);
      }
      return true;
    }

    // POST — write file
    if (req.method === 'POST') {
      if (resolved.readOnly) {
        sendError(res, 'Mount is read-only', 403);
        return true;
      }
      try {
        const body = await collectBody(req, res, MAX_UPLOAD_SIZE);
        const result = await storageWrite(filePath, body);
        if (!result.success) {
          sendError(res, result.error ?? 'Write failed');
          return true;
        }
        sendJson(res, { ok: true, path: result.path });
      } catch {
        // collectBody already sent 413 if body too large
        if (!res.writableEnded) {
          sendError(res, 'Write failed');
        }
      }
      return true;
    }

    // DELETE — remove file
    if (req.method === 'DELETE') {
      if (resolved.readOnly) {
        sendError(res, 'Mount is read-only', 403);
        return true;
      }
      const result = await storageDelete(filePath);
      if (!result.success) {
        sendError(res, result.error ?? 'Delete failed');
        return true;
      }
      sendJson(res, { ok: true, path: result.path });
      return true;
    }
  }

  return false;
}
