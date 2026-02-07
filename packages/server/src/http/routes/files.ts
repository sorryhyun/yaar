/**
 * File-serving routes — PDF render, sandbox, app static, storage files.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { readFile, readdir } from 'fs/promises';
import { join, extname } from 'path';
import { renderPdfPage } from '../../lib/pdf/index.js';
import { STORAGE_DIR, PROJECT_ROOT, MIME_TYPES } from '../../config.js';
import { sendError, safePath } from '../utils.js';

/** Supported image extensions for app icons */
const ICON_IMAGE_EXTENSIONS = new Set(['.png', '.webp', '.jpg', '.jpeg', '.gif', '.svg']);

export async function handleFileRoutes(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  // Render PDF page as image
  // URL format: /api/pdf/<path>/<page> (e.g., /api/pdf/documents/paper.pdf/1)
  const pdfMatch = url.pathname.match(/^\/api\/pdf\/(.+)\/(\d+)$/);
  if (pdfMatch && req.method === 'GET') {
    const pdfPath = decodeURIComponent(pdfMatch[1]);
    const pageNum = parseInt(pdfMatch[2], 10);

    const normalizedPath = safePath(STORAGE_DIR, pdfPath);
    if (!normalizedPath) {
      sendError(res, 'Access denied', 403);
      return true;
    }

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
  // URL format: /api/apps/{appId}/static/{path}
  const appStaticMatch = url.pathname.match(/^\/api\/apps\/([a-z][a-z0-9-]*)\/static\/(.+)$/);
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
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
      });
      res.end(content);
    } catch {
      sendError(res, 'File not found', 404);
    }
    return true;
  }

  // Serve storage files
  if (url.pathname.startsWith('/api/storage/') && req.method === 'GET') {
    const filePath = decodeURIComponent(url.pathname.slice('/api/storage/'.length));

    const normalizedPath = safePath(STORAGE_DIR, filePath);
    if (!normalizedPath) {
      sendError(res, 'Access denied', 403);
      return true;
    }

    try {
      const content = await readFile(normalizedPath);
      const ext = extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
      });
      res.end(content);
    } catch {
      sendError(res, 'File not found', 404);
    }
    return true;
  }

  return false;
}
