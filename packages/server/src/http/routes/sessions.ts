/**
 * Session routes — listing, transcript, messages, and restore.
 *
 * GET  /api/sessions                    — list all sessions
 * GET  /api/sessions/:id/transcript     — get session transcript
 * GET  /api/sessions/:id/messages       — get session messages (for replay)
 * POST /api/sessions/:id/restore        — restore session (window actions + context)
 */

import {
  listSessions,
  readSessionTranscript,
  readSessionMessages,
  parseSessionMessages,
  getWindowRestoreActions,
  refreshIframeTokens,
  getContextRestoreMessages,
} from '../../logging/index.js';
import type { ContextRestorePolicy } from '../../logging/index.js';
import { jsonResponse, errorResponse, type EndpointMeta } from '../utils.js';

export const PUBLIC_ENDPOINTS: EndpointMeta[] = [
  {
    method: 'GET',
    path: '/api/sessions',
    response: '`{ sessions: SessionInfo[] }`',
    description: 'List all saved sessions',
  },
  {
    method: 'GET',
    path: '/api/sessions/:id/transcript',
    response: '`{ transcript: string }`',
    description: 'Get session transcript',
  },
  {
    method: 'GET',
    path: '/api/sessions/:id/messages',
    response: '`{ messages: SessionMessage[] }`',
    description: 'Get session messages for replay',
  },
  {
    method: 'POST',
    path: '/api/sessions/:id/restore',
    response: '`{ actions: OSAction[], contextMessages: Message[] }`',
    description: 'Restore session with window actions and context',
  },
];

export async function handleSessionRoutes(req: Request, url: URL): Promise<Response | null> {
  // List all sessions
  if (url.pathname === '/api/sessions' && req.method === 'GET') {
    try {
      const sessions = await listSessions();
      return jsonResponse({ sessions });
    } catch {
      return errorResponse('Failed to list sessions');
    }
  }

  // Get session transcript
  const transcriptMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/transcript$/);
  if (transcriptMatch && req.method === 'GET') {
    const sessionId = transcriptMatch[1];
    try {
      const transcript = await readSessionTranscript(sessionId);
      if (transcript === null) {
        return errorResponse('Session not found', 404);
      }
      return jsonResponse({ transcript });
    } catch {
      return errorResponse('Failed to read transcript');
    }
  }

  // Get session messages (for replay)
  const messagesMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (messagesMatch && req.method === 'GET') {
    const sessionId = messagesMatch[1];
    try {
      const messagesJsonl = await readSessionMessages(sessionId);
      if (messagesJsonl === null) {
        return errorResponse('Session not found', 404);
      }
      const messages = parseSessionMessages(messagesJsonl);
      return jsonResponse({ messages });
    } catch {
      return errorResponse('Failed to read messages');
    }
  }

  // Restore session (returns window create actions + context according to restore policy)
  const restoreMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/restore$/);
  if (restoreMatch && req.method === 'POST') {
    const sessionId = restoreMatch[1];
    try {
      let policy: ContextRestorePolicy | undefined;
      const body = await req.text();
      if (body.trim()) {
        try {
          const parsed = JSON.parse(body) as { policy?: ContextRestorePolicy };
          policy = parsed.policy;
        } catch {
          return errorResponse('Invalid JSON body', 400);
        }
      }

      const messagesJsonl = await readSessionMessages(sessionId);
      if (messagesJsonl === null) {
        return errorResponse('Session not found', 404);
      }
      const messages = parseSessionMessages(messagesJsonl);
      const rawActions = getWindowRestoreActions(messages);
      const restoreActions = await refreshIframeTokens(rawActions, sessionId);
      const contextMessages = getContextRestoreMessages(messages, policy);
      return jsonResponse({ actions: restoreActions, contextMessages });
    } catch {
      return errorResponse('Failed to restore session');
    }
  }

  return null;
}
