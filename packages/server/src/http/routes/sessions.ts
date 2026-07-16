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
import { jsonResponse, errorResponse, parseJsonBody, type EndpointMeta } from '../utils.js';
import { requireHost, requirePermission, resolvePrincipal } from '../access.js';

/**
 * Empty on purpose — a session transcript is the user's entire conversation with the
 * AI, for *every* session, and this was public. An app that needs history declares
 * `yaar://history/` in app.json and reads it through POST /api/verb, which is the
 * same data behind the same check.
 */
export const PUBLIC_ENDPOINTS: EndpointMeta[] = [];

export async function handleSessionRoutes(req: Request, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/sessions')) return null;

  const principal = resolvePrincipal(req, url);
  if (principal instanceof Response) return principal;

  // List all sessions
  if (url.pathname === '/api/sessions' && req.method === 'GET') {
    const denied = requirePermission(principal, 'yaar://history/', 'list');
    if (denied) return denied;
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
    const denied = requirePermission(principal, `yaar://history/${sessionId}/transcript`, 'read');
    if (denied) return denied;
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
    const denied = requirePermission(principal, `yaar://history/${sessionId}/messages`, 'read');
    if (denied) return denied;
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
    // Host only. Restoring rebuilds the desktop *and mints fresh iframe tokens* for
    // every window it brings back (refreshIframeTokens below) — it is the desktop
    // reconstituting itself, not a resource an app can hold a permission for.
    const denied = requireHost(principal);
    if (denied) return denied;
    try {
      const parsed = await parseJsonBody<{ policy?: ContextRestorePolicy }>(req, {
        allowEmpty: true,
      });
      if (parsed instanceof Response) return parsed;
      const policy: ContextRestorePolicy | undefined = parsed?.policy;

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
