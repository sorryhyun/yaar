/**
 * Frontend static file serving + SPA fallback.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { readFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, extname } from 'path';
import { FRONTEND_DIST, MIME_TYPES } from '../../config.js';

export async function handleStaticRoutes(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (!existsSync(FRONTEND_DIST)) {
    return false;
  }

  // Determine file path
  const staticPath = join(FRONTEND_DIST, url.pathname === '/' ? 'index.html' : url.pathname);

  try {
    const fileStat = await stat(staticPath);
    if (fileStat.isFile()) {
      const content = await readFile(staticPath);
      const ext = extname(staticPath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
      return true;
    }
  } catch {
    // File doesn't exist, continue to SPA fallback
  }

  // SPA fallback: serve index.html for non-API/non-WS routes
  if (!url.pathname.startsWith('/api') && !url.pathname.startsWith('/ws')) {
    const indexPath = join(FRONTEND_DIST, 'index.html');
    if (existsSync(indexPath)) {
      try {
        const content = await readFile(indexPath);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(content);
        return true;
      } catch {
        // Fall through to 404
      }
    }
  }

  return false;
}
