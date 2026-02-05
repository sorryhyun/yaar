/**
 * YAAR TypeScript Backend Entry Point.
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
import { getAvailableProviders, initWarmPool, getWarmPool } from './providers/factory.js';
import { listSessions, readSessionTranscript, readSessionMessages, parseSessionMessages, getWindowRestoreActions, getContextRestoreMessages } from './logging/index.js';
import { ensureStorageDir } from './storage/index.js';
import { initMcpServer, handleMcpRequest, MCP_SERVERS, type McpServerName } from './mcp/server.js';
import { windowState } from './mcp/window-state.js';
import { reloadCache } from './reload/index.js';
import { listApps } from './mcp/tools/apps.js';
import type { ClientEvent, ServerEvent, OSAction } from '@yaar/shared';
import { getBroadcastCenter, generateConnectionId } from './events/broadcast-center.js';

// Detect if running as bundled executable
const IS_BUNDLED_EXE =
  typeof process.env.BUN_SELF_EXEC !== 'undefined' ||
  process.argv[0]?.endsWith('.exe') ||
  process.argv[0]?.includes('yaar');

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
  if (process.env.YAAR_STORAGE) {
    return process.env.YAAR_STORAGE;
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

// Restore actions from the most recent previous session (populated at startup)
let startupRestoreActions: OSAction[] = [];

// Restored context tape messages from previous session
import type { ContextMessage } from './agents/context.js';
let startupContextMessages: ContextMessage[] = [];

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

  // MCP endpoints for tool calls (/mcp/system, /mcp/window, /mcp/storage, /mcp/apps)
  const mcpMatch = url.pathname.match(/^\/mcp\/(\w+)$/);
  if (mcpMatch && (req.method === 'POST' || req.method === 'GET' || req.method === 'DELETE')) {
    const serverName = mcpMatch[1] as McpServerName;
    if ((MCP_SERVERS as readonly string[]).includes(serverName)) {
      await handleMcpRequest(req, res, serverName);
      return;
    }
  }

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

  // List available apps
  if (url.pathname === '/api/apps' && req.method === 'GET') {
    try {
      const apps = await listApps();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ apps }));
    } catch {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to list apps' }));
    }
    return;
  }

  // List all sessions
  if (url.pathname === '/api/sessions' && req.method === 'GET') {
    try {
      const sessions = await listSessions();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessions }));
    } catch {
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
    } catch {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to read transcript' }));
    }
    return;
  }

  // Get session messages (for replay)
  const messagesMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (messagesMatch && req.method === 'GET') {
    const sessionId = messagesMatch[1];
    try {
      const messagesJsonl = await readSessionMessages(sessionId);
      if (messagesJsonl === null) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }
      const messages = parseSessionMessages(messagesJsonl);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ messages }));
    } catch {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to read messages' }));
    }
    return;
  }

  // Restore session (returns window create actions to recreate window state)
  const restoreMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/restore$/);
  if (restoreMatch && req.method === 'POST') {
    const sessionId = restoreMatch[1];
    try {
      const messagesJsonl = await readSessionMessages(sessionId);
      if (messagesJsonl === null) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }
      const messages = parseSessionMessages(messagesJsonl);
      const restoreActions = getWindowRestoreActions(messages);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ actions: restoreActions }));
    } catch {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to restore session' }));
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
    const warmPoolStats = getWarmPool().getStats();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      agents: limiterStats,
      connections: broadcastStats,
      warmPool: warmPoolStats,
    }));
    return;
  }

  // Serve sandbox files (for previewing compiled apps)
  // URL format: /api/sandbox/{sandboxId}/{path}
  const sandboxMatch = url.pathname.match(/^\/api\/sandbox\/(\d+)\/(.+)$/);
  if (sandboxMatch && req.method === 'GET') {
    const sandboxId = sandboxMatch[1];
    const filePath = decodeURIComponent(sandboxMatch[2]);

    const sandboxDir = join(PROJECT_ROOT, 'sandbox', sandboxId);
    const normalizedPath = normalize(join(sandboxDir, filePath));
    const relativePath = relative(sandboxDir, normalizedPath);

    // Validate path to prevent directory traversal
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
        'Cache-Control': 'no-cache'  // No caching for dev sandbox
      });
      res.end(content);
    } catch {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File not found' }));
    }
    return;
  }

  // Serve app static files (for deployed apps)
  // URL format: /api/apps/{appId}/static/{path}
  const appStaticMatch = url.pathname.match(/^\/api\/apps\/([a-z][a-z0-9-]*)\/static\/(.+)$/);
  if (appStaticMatch && req.method === 'GET') {
    const appId = appStaticMatch[1];
    const filePath = decodeURIComponent(appStaticMatch[2]);

    const appsDir = join(PROJECT_ROOT, 'apps', appId);
    const normalizedPath = normalize(join(appsDir, filePath));
    const relativePath = relative(appsDir, normalizedPath);

    // Validate path to prevent directory traversal
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
    } catch {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File not found' }));
    }
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
    } catch {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File not found' }));
    }
    return;
  }

  // Serve static frontend files (for bundled exe or production)
  if (existsSync(FRONTEND_DIST)) {
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

  const manager = new SessionManager(connectionId, startupContextMessages);

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

  // Mark as initialized immediately - pool initialization is lazy (on first message)
  // This avoids wasting warm providers on connections that disconnect before sending messages
  initialized = true;

  // Initialize manager (no-op, actual pool init is lazy)
  await manager.initialize();

  // Send ready status immediately so frontend knows the connection is established
  // The actual provider info will be sent when the pool initializes on first message
  const readyEvent: ServerEvent = {
    type: 'CONNECTION_STATUS',
    status: 'connected',
    provider: getWarmPool().getPreferredProvider() ?? 'claude',
  };
  ws.send(JSON.stringify(readyEvent));

  // Send restored window state from previous session
  if (startupRestoreActions.length > 0) {
    const restoreEvent: ServerEvent = {
      type: 'ACTIONS',
      actions: startupRestoreActions,
    };
    ws.send(JSON.stringify(restoreEvent));
  }

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

// Initialize storage and MCP server, then start HTTP server
async function startup() {
  await ensureStorageDir();
  await reloadCache.load();
  windowState.setOnWindowClose((wid) => reloadCache.invalidateForWindow(wid));
  await initMcpServer();

  // Pre-warm provider pool for faster first connection
  const warmPoolReady = await initWarmPool();
  if (warmPoolReady) {
    const stats = getWarmPool().getStats();
    console.log(`Provider warm pool ready: ${stats.available} ${stats.preferredProvider} provider(s)`);
  }

  // Restore window state from the most recent previous session
  try {
    const sessions = await listSessions();
    if (sessions.length > 0) {
      const lastSession = sessions[0];
      const messagesJsonl = await readSessionMessages(lastSession.sessionId);
      if (messagesJsonl) {
        const messages = parseSessionMessages(messagesJsonl);
        const restoreActions = getWindowRestoreActions(messages);
        if (restoreActions.length > 0) {
          windowState.restoreFromActions(restoreActions);
          startupRestoreActions = restoreActions;
          console.log(`Restored ${restoreActions.length} window(s) from session ${lastSession.sessionId}`);
        }
        const contextMessages = getContextRestoreMessages(messages);
        if (contextMessages.length > 0) {
          startupContextMessages = contextMessages;
          console.log(`Restored ${contextMessages.length} context message(s) from session ${lastSession.sessionId}`);
        }
      }
    }
  } catch (err) {
    console.error('Failed to restore previous session:', err);
  }

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`YAAR server running at http://127.0.0.1:${PORT}`);
    console.log('WebSocket endpoint: ws://127.0.0.1:' + PORT + '/ws');
    console.log('MCP endpoints: http://127.0.0.1:' + PORT + '/mcp/{system,window,storage,apps}');
  });
}

startup();

// Graceful shutdown
async function shutdown() {
  console.log('\nShutting down...');

  // Clean up warm pool
  await getWarmPool().cleanup();

  wss.close(() => {
    server.close(() => {
      process.exit(0);
    });
  });
  // Force exit after 2 seconds if graceful shutdown hangs
  setTimeout(() => process.exit(0), 2000);
}

// Wrap shutdown for signal handlers
function handleShutdown() {
  shutdown().catch((err) => {
    console.error('Shutdown error:', err);
    process.exit(1);
  });
}

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);
