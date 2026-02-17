/**
 * REST API routes — health, providers, apps, sessions, agents/stats.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { getAvailableProviders, getWarmPool } from '../../providers/factory.js';
import {
  listSessions,
  readSessionTranscript,
  readSessionMessages,
  parseSessionMessages,
  getWindowRestoreActions,
  getContextRestoreMessages,
} from '../../logging/index.js';
import { getAgentLimiter } from '../../agents/index.js';
import { listApps } from '../../mcp/apps/discovery.js';
import { getBroadcastCenter } from '../../session/broadcast-center.js';
import { sendJson, sendError } from '../utils.js';
import { readSettings, updateSettings } from '../../storage/settings.js';
import { readShortcuts } from '../../storage/shortcuts.js';
import type { ContextRestorePolicy } from '../../logging/index.js';
import { readAllowedDomains, isAllDomainsAllowed, setAllowAllDomains } from '../../mcp/domains.js';

export async function handleApiRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  // Health check
  if (url.pathname === '/health' && req.method === 'GET') {
    sendJson(res, { status: 'ok' });
    return true;
  }

  // List available providers
  if (url.pathname === '/api/providers' && req.method === 'GET') {
    const providers = await getAvailableProviders();
    sendJson(res, { providers });
    return true;
  }

  // List available apps
  if (url.pathname === '/api/apps' && req.method === 'GET') {
    try {
      const [apps, settings] = await Promise.all([listApps(), readSettings()]);
      sendJson(res, {
        apps,
        onboardingCompleted: settings.onboardingCompleted,
        language: settings.language,
      });
    } catch {
      sendError(res, 'Failed to list apps');
    }
    return true;
  }

  // List desktop shortcuts
  if (url.pathname === '/api/shortcuts' && req.method === 'GET') {
    try {
      const shortcuts = await readShortcuts();
      sendJson(res, { shortcuts });
    } catch {
      sendError(res, 'Failed to list shortcuts');
    }
    return true;
  }

  // Update settings
  if (url.pathname === '/api/settings' && req.method === 'PATCH') {
    try {
      const bodyChunks: Buffer[] = [];
      for await (const chunk of req) {
        bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = Buffer.concat(bodyChunks).toString('utf-8').trim();
      if (!body) {
        sendError(res, 'Empty body', 400);
        return true;
      }
      let partial: Record<string, unknown>;
      try {
        partial = JSON.parse(body);
      } catch {
        sendError(res, 'Invalid JSON', 400);
        return true;
      }
      const settings = await updateSettings(partial as any);
      sendJson(res, settings);
    } catch {
      sendError(res, 'Failed to update settings');
    }
    return true;
  }

  // List all sessions
  if (url.pathname === '/api/sessions' && req.method === 'GET') {
    try {
      const sessions = await listSessions();
      sendJson(res, { sessions });
    } catch {
      sendError(res, 'Failed to list sessions');
    }
    return true;
  }

  // Get session transcript
  const transcriptMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/transcript$/);
  if (transcriptMatch && req.method === 'GET') {
    const sessionId = transcriptMatch[1];
    try {
      const transcript = await readSessionTranscript(sessionId);
      if (transcript === null) {
        sendError(res, 'Session not found', 404);
        return true;
      }
      sendJson(res, { transcript });
    } catch {
      sendError(res, 'Failed to read transcript');
    }
    return true;
  }

  // Get session messages (for replay)
  const messagesMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (messagesMatch && req.method === 'GET') {
    const sessionId = messagesMatch[1];
    try {
      const messagesJsonl = await readSessionMessages(sessionId);
      if (messagesJsonl === null) {
        sendError(res, 'Session not found', 404);
        return true;
      }
      const messages = parseSessionMessages(messagesJsonl);
      sendJson(res, { messages });
    } catch {
      sendError(res, 'Failed to read messages');
    }
    return true;
  }

  // Restore session (returns window create actions + context according to restore policy)
  const restoreMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/restore$/);
  if (restoreMatch && req.method === 'POST') {
    const sessionId = restoreMatch[1];
    try {
      let policy: ContextRestorePolicy | undefined;
      const bodyChunks: Buffer[] = [];
      for await (const chunk of req) {
        bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = Buffer.concat(bodyChunks).toString('utf-8').trim();
      if (body) {
        try {
          const parsed = JSON.parse(body) as { policy?: ContextRestorePolicy };
          policy = parsed.policy;
        } catch {
          sendError(res, 'Invalid JSON body', 400);
          return true;
        }
      }

      const messagesJsonl = await readSessionMessages(sessionId);
      if (messagesJsonl === null) {
        sendError(res, 'Session not found', 404);
        return true;
      }
      const messages = parseSessionMessages(messagesJsonl);
      const restoreActions = getWindowRestoreActions(messages);
      const contextMessages = getContextRestoreMessages(messages, policy);
      sendJson(res, { actions: restoreActions, contextMessages });
    } catch {
      sendError(res, 'Failed to restore session');
    }
    return true;
  }

  // Get domain settings
  if (url.pathname === '/api/domains' && req.method === 'GET') {
    try {
      const [allowAllDomains, domains] = await Promise.all([
        isAllDomainsAllowed(),
        readAllowedDomains(),
      ]);
      sendJson(res, { allowAllDomains, domains });
    } catch {
      sendError(res, 'Failed to read domain settings');
    }
    return true;
  }

  // Update domain settings
  if (url.pathname === '/api/domains' && req.method === 'PATCH') {
    try {
      const bodyChunks: Buffer[] = [];
      for await (const chunk of req) {
        bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = Buffer.concat(bodyChunks).toString('utf-8').trim();
      if (!body) {
        sendError(res, 'Empty body', 400);
        return true;
      }
      let partial: { allowAllDomains?: boolean };
      try {
        partial = JSON.parse(body);
      } catch {
        sendError(res, 'Invalid JSON', 400);
        return true;
      }
      if (typeof partial.allowAllDomains === 'boolean') {
        await setAllowAllDomains(partial.allowAllDomains);
      }
      const [allowAllDomains, domains] = await Promise.all([
        isAllDomainsAllowed(),
        readAllowedDomains(),
      ]);
      sendJson(res, { allowAllDomains, domains });
    } catch {
      sendError(res, 'Failed to update domain settings');
    }
    return true;
  }

  // Agent stats endpoint
  if (url.pathname === '/api/agents/stats' && req.method === 'GET') {
    const limiterStats = getAgentLimiter().getStats();
    const broadcastStats = getBroadcastCenter().getStats();
    const warmPoolStats = getWarmPool().getStats();
    sendJson(res, {
      agents: limiterStats,
      connections: broadcastStats,
      warmPool: warmPoolStats,
    });
    return true;
  }

  return false;
}
