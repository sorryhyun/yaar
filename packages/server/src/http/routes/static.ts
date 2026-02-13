/**
 * Frontend static file serving + SPA fallback.
 *
 * When running as a bundled executable, serves from Bun.embeddedFiles first.
 * Falls back to filesystem serving for dev mode or if no embedded assets found.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { readFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, extname } from 'path';
import { FRONTEND_DIST, IS_BUNDLED_EXE, MIME_TYPES } from '../../config.js';

// ── Embedded asset serving (bundled exe) ─────────────────────────────

/**
 * Lazy-built map from URL path → embedded file path (/$bunfs/root/...).
 * Populated from __YAAR_EMBEDDED_FRONTEND which the build script sets on globalThis.
 */
let embeddedAssets: Map<string, string> | undefined;

function getEmbeddedAssets(): Map<string, string> {
  if (embeddedAssets) return embeddedAssets;
  embeddedAssets = new Map();

  const frontend = (globalThis as any).__YAAR_EMBEDDED_FRONTEND as
    | Record<string, string>
    | undefined;
  if (frontend) {
    for (const [urlPath, filePath] of Object.entries(frontend)) {
      embeddedAssets.set(urlPath, filePath);
    }
  }

  console.log(`[static] Loaded ${embeddedAssets.size} embedded frontend assets`);
  return embeddedAssets;
}

async function serveEmbeddedAsset(
  res: ServerResponse,
  filePath: string,
  urlPath: string,
): Promise<void> {
  const ext = extname(urlPath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  // Bun.file() reads from the embedded /$bunfs/ path
  const file = (globalThis as any).Bun.file(filePath);
  const buffer = Buffer.from(await file.arrayBuffer());
  res.writeHead(200, { 'Content-Type': contentType });
  res.end(buffer);
}

// ── Main handler ─────────────────────────────────────────────────────

export async function handleStaticRoutes(
  _req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  // Try embedded assets first when bundled
  if (IS_BUNDLED_EXE) {
    const assets = getEmbeddedAssets();
    if (assets.size > 0) {
      // Direct file match
      const reqPath = url.pathname === '/' ? '/index.html' : url.pathname;
      const embeddedPath = assets.get(reqPath);
      if (embeddedPath) {
        await serveEmbeddedAsset(res, embeddedPath, reqPath);
        return true;
      }

      // SPA fallback: serve index.html for non-API/non-WS routes
      if (!url.pathname.startsWith('/api') && !url.pathname.startsWith('/ws')) {
        const indexPath = assets.get('/index.html');
        if (indexPath) {
          await serveEmbeddedAsset(res, indexPath, '/index.html');
          return true;
        }
      }

      return false;
    }
  }

  // Filesystem fallback (dev mode or no embedded assets)
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
