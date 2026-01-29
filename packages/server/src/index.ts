/**
 * ClaudeOS TypeScript Backend Entry Point.
 *
 * WebSocket server that connects the frontend to AI providers
 * via the transport layer.
 */

import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { SessionManager } from './session-manager.js';
import { getAvailableTransports } from './providers/factory.js';
import { listSessions, readSessionTranscript } from './sessions/index.js';
import { ensureStorageDir } from './storage/index.js';
import type { ClientEvent } from '@claudeos/shared';

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
    const providers = await getAvailableTransports();
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

  // 404 for unknown routes
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// Create WebSocket server
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', async (ws: WebSocket) => {
  console.log('WebSocket client connected');

  const manager = new SessionManager(ws);

  // Track initialization state and queue early messages
  let initialized = false;
  const messageQueue: ClientEvent[] = [];

  // Register message handler IMMEDIATELY to capture any early messages
  ws.on('message', async (data) => {
    try {
      const event = JSON.parse(data.toString()) as ClientEvent;

      if (!initialized) {
        // Queue messages that arrive before initialization completes
        console.log('Queuing early message:', event.type);
        messageQueue.push(event);
        return;
      }

      await manager.routeMessage(event);
    } catch (err) {
      console.error('Failed to process message:', err);
    }
  });

  // Handle close
  ws.on('close', async () => {
    console.log('WebSocket client disconnected');
    await manager.cleanup();
  });

  // Handle errors
  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });

  // Initialize main session (async)
  const initSuccess = await manager.initialize();
  if (!initSuccess) {
    ws.close(1011, 'No provider available');
    return;
  }

  // Mark as initialized and process any queued messages
  initialized = true;

  if (messageQueue.length > 0) {
    console.log(`Processing ${messageQueue.length} queued message(s)`);
    for (const event of messageQueue) {
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
