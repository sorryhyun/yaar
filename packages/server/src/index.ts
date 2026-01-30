/**
 * ClaudeOS TypeScript Backend Entry Point.
 *
 * WebSocket server that connects the frontend to AI providers
 * via the transport layer.
 */

import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { readFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, normalize, relative, extname } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { renderPdfPage } from './pdf/index.js';
import { SessionManager, getAgentLimiter } from './agents/index.js';
import { getAvailableProviders } from './providers/factory.js';
import { listSessions, readSessionTranscript } from './logging/index.js';
import { ensureStorageDir } from './storage/index.js';
import type { ClientEvent } from '@claudeos/shared';
import { getBroadcastCenter, generateConnectionId } from './events/broadcast-center.js';

// Detect if running as bundled executable
const IS_BUNDLED_EXE =
  typeof process.env.BUN_SELF_EXEC !== 'undefined' ||
  process.argv[0]?.endsWith('.exe') ||
  process.argv[0]?.includes('claudeos');

// Storage directory path
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');

/**
 * Get the storage directory path.
 * - Environment variable override
 * - Bundled exe: ./storage/ alongside executable
 * - Development: project root /storage/
 */
function getStorageDir(): string {
  if (process.env.CLAUDEOS_STORAGE) {
    return process.env.CLAUDEOS_STORAGE;
  }
  if (IS_BUNDLED_EXE) {
    return join(dirname(process.execPath), 'storage');
  }
  return join(PROJECT_ROOT, 'storage');
}

const STORAGE_DIR = getStorageDir();

// Export for use by other modules
export { STORAGE_DIR };

/**
 * Get the frontend dist directory path.
 * - Environment variable override
 * - Bundled exe: ./public/ alongside executable
 * - Development: packages/frontend/dist/
 */
function getFrontendDist(): string {
  if (process.env.FRONTEND_DIST) {
    return process.env.FRONTEND_DIST;
  }
  if (IS_BUNDLED_EXE) {
    return join(dirname(process.execPath), 'public');
  }
  return join(PROJECT_ROOT, 'packages', 'frontend', 'dist');
}

const FRONTEND_DIST = getFrontendDist();

// MIME type mapping for common file types
const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
};

const PORT = parseInt(process.env.PORT ?? '8000', 10);

// Create HTTP server for health checks and REST endpoints
const server = createServer(async (req, res) => {
  // CORS headers
  const origin = req.headers.origin;
  const allowedOrigins = ['http://localhost:5173', 'http://localhost:3000'];

  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  // Health check
  if (url.pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // List available providers
  if (url.pathname === '/api/providers' && req.method === 'GET') {
    const providers = await getAvailableProviders();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ providers }));
    return;
  }

  // List all sessions
  if (url.pathname === '/api/sessions' && req.method === 'GET') {
    try {
      const sessions = await listSessions();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessions }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to list sessions' }));
    }
    return;
  }

  // Get session transcript
  const transcriptMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/transcript$/);
  if (transcriptMatch && req.method === 'GET') {
    const sessionId = transcriptMatch[1];
    try {
      const transcript = await readSessionTranscript(sessionId);
      if (transcript === null) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ transcript }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to read transcript' }));
    }
    return;
  }

  // Render PDF page as image
  // URL format: /api/pdf/<path>/<page> (e.g., /api/pdf/documents/paper.pdf/1)
  const pdfMatch = url.pathname.match(/^\/api\/pdf\/(.+)\/(\d+)$/);
  if (pdfMatch && req.method === 'GET') {
    const pdfPath = decodeURIComponent(pdfMatch[1]);
    const pageNum = parseInt(pdfMatch[2], 10);

    // Validate path to prevent directory traversal
    const normalizedPath = normalize(join(STORAGE_DIR, pdfPath));
    const relativePath = relative(STORAGE_DIR, normalizedPath);

    if (relativePath.startsWith('..') || relativePath.includes('..')) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Access denied' }));
      return;
    }

    if (extname(pdfPath).toLowerCase() !== '.pdf') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not a PDF file' }));
      return;
    }

    try {
      // Use poppler-based PDF rendering
      const pngBuffer = await renderPdfPage(normalizedPath, pageNum, 1.5);

      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=3600'
      });
      res.end(pngBuffer);
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Unknown error';
      if (error.includes('Failed to render page')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error }));
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to render PDF page' }));
      }
    }
    return;
  }

  // Agent stats endpoint
  if (url.pathname === '/api/agents/stats' && req.method === 'GET') {
    const limiterStats = getAgentLimiter().getStats();
    const broadcastStats = getBroadcastCenter().getStats();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      agents: limiterStats,
      connections: broadcastStats,
    }));
    return;
  }

  // Serve storage files
  if (url.pathname.startsWith('/api/storage/') && req.method === 'GET') {
    const filePath = decodeURIComponent(url.pathname.slice('/api/storage/'.length));

    // Validate path to prevent directory traversal
    const normalizedPath = normalize(join(STORAGE_DIR, filePath));
    const relativePath = relative(STORAGE_DIR, normalizedPath);

    if (relativePath.startsWith('..') || relativePath.includes('..')) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Access denied' }));
      return;
    }

    try {
      const content = await readFile(normalizedPath);
      const ext = extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600'
      });
      res.end(content);
    } catch (err) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File not found' }));
    }
    return;
  }

  // Serve static frontend files (for bundled exe or production)
  if (existsSync(FRONTEND_DIST)) {
    // Determine file path
    let staticPath = join(FRONTEND_DIST, url.pathname === '/' ? 'index.html' : url.pathname);

    try {
      const fileStat = await stat(staticPath);
      if (fileStat.isFile()) {
        const content = await readFile(staticPath);
        const ext = extname(staticPath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
        return;
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
          return;
        } catch {
          // Fall through to 404
        }
      }
    }
  }

  // 404 for unknown routes
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// Create WebSocket server
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', async (ws: WebSocket) => {
  // Generate unique connection ID for this WebSocket
  const connectionId = generateConnectionId();
  const broadcastCenter = getBroadcastCenter();

  console.log(`WebSocket client connected: ${connectionId}`);

  // Register connection with broadcast center
  broadcastCenter.subscribe(connectionId, ws);

  const manager = new SessionManager(connectionId);

  // Track initialization state and queue early messages
  let initialized = false;
  const earlyMessageQueue: ClientEvent[] = [];

  // Register message handler IMMEDIATELY to capture any early messages
  ws.on('message', async (data) => {
    try {
      const event = JSON.parse(data.toString()) as ClientEvent;

      if (!initialized) {
        // Queue messages that arrive before initialization completes
        console.log('Queuing early message:', event.type);
        earlyMessageQueue.push(event);
        return;
      }

      await manager.routeMessage(event);
    } catch (err) {
      console.error('Failed to process message:', err);
    }
  });

  // Handle close
  ws.on('close', async () => {
    console.log(`WebSocket client disconnected: ${connectionId}`);
    // Cleanup manager first (releases agent slots)
    await manager.cleanup();
    // Then unsubscribe from broadcast center
    broadcastCenter.unsubscribe(connectionId);
  });

  // Handle errors
  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });

  // Initialize main session (async)
  const initSuccess = await manager.initialize();
  if (!initSuccess) {
    broadcastCenter.unsubscribe(connectionId);
    ws.close(1011, 'No provider available');
    return;
  }

  // Mark as initialized and process any queued messages
  initialized = true;

  if (earlyMessageQueue.length > 0) {
    console.log(`Processing ${earlyMessageQueue.length} queued message(s)`);
    for (const event of earlyMessageQueue) {
      try {
        await manager.routeMessage(event);
      } catch (err) {
        console.error('Failed to process queued message:', err);
      }
    }
  }
});

// Initialize storage and start server
ensureStorageDir().then(() => {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`ClaudeOS server running at http://127.0.0.1:${PORT}`);
    console.log('WebSocket endpoint: ws://127.0.0.1:' + PORT + '/ws');
  });
});

// Graceful shutdown
function shutdown() {
  console.log('\nShutting down...');
  wss.close(() => {
    server.close(() => {
      process.exit(0);
    });
  });
  // Force exit after 2 seconds if graceful shutdown hangs
  setTimeout(() => process.exit(0), 2000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
