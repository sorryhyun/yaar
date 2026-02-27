/**
 * Frontend static file serving + SPA fallback.
 *
 * When running as a bundled executable, serves from Bun.embeddedFiles first.
 * Falls back to filesystem serving for dev mode or if no embedded assets found.
 */

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

async function serveEmbeddedAsset(filePath: string, urlPath: string): Promise<Response> {
  const ext = extname(urlPath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  // Bun.file() reads from the embedded /$bunfs/ path
  const file = Bun.file(filePath);
  return new Response(file, {
    headers: { 'Content-Type': contentType },
  });
}

// ── Main handler ─────────────────────────────────────────────────────

export async function handleStaticRoutes(_req: Request, url: URL): Promise<Response | null> {
  // Try embedded assets first when bundled
  if (IS_BUNDLED_EXE) {
    const assets = getEmbeddedAssets();
    if (assets.size > 0) {
      // Direct file match
      const reqPath = url.pathname === '/' ? '/index.html' : url.pathname;
      const embeddedPath = assets.get(reqPath);
      if (embeddedPath) {
        return serveEmbeddedAsset(embeddedPath, reqPath);
      }

      // SPA fallback: serve index.html for non-API/non-WS routes
      if (!url.pathname.startsWith('/api') && !url.pathname.startsWith('/ws')) {
        const indexPath = assets.get('/index.html');
        if (indexPath) {
          return serveEmbeddedAsset(indexPath, '/index.html');
        }
      }

      return null;
    }
  }

  // Filesystem fallback (dev mode or no embedded assets)
  if (!existsSync(FRONTEND_DIST)) {
    return null;
  }

  // Determine file path
  const staticPath = join(FRONTEND_DIST, url.pathname === '/' ? 'index.html' : url.pathname);

  // Try serving the file directly with Bun.file()
  const file = Bun.file(staticPath);
  if (await file.exists()) {
    const ext = extname(staticPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    return new Response(file, {
      headers: { 'Content-Type': contentType },
    });
  }

  // SPA fallback: serve index.html for non-API/non-WS routes
  if (!url.pathname.startsWith('/api') && !url.pathname.startsWith('/ws')) {
    const indexPath = join(FRONTEND_DIST, 'index.html');
    const indexFile = Bun.file(indexPath);
    if (await indexFile.exists()) {
      return new Response(indexFile, {
        headers: { 'Content-Type': 'text/html' },
      });
    }
  }

  return null;
}
