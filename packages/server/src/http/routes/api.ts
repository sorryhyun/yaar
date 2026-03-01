/**
 * REST API routes — health, providers, apps, sessions, agents/stats.
 */

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
import { jsonResponse, errorResponse, type EndpointMeta } from '../utils.js';

export const PUBLIC_ENDPOINTS: EndpointMeta[] = [
  {
    method: 'GET',
    path: '/api/apps',
    response: '`{ apps: AppInfo[] }`',
    description: 'List all installed apps',
  },
  {
    method: 'GET',
    path: '/api/shortcuts',
    response: '`{ shortcuts: DesktopShortcut[] }`',
    description: 'List desktop shortcuts',
  },
];
import { readSettings, updateSettings } from '../../storage/settings.js';
import { readShortcuts } from '../../storage/shortcuts.js';
import type { ContextRestorePolicy } from '../../logging/index.js';
import { readAllowedDomains, isAllDomainsAllowed, setAllowAllDomains } from '../../mcp/domains.js';
import { pickDirectory } from '../../lib/pick-directory.js';

export async function handleApiRoutes(req: Request, url: URL): Promise<Response | null> {
  // Health check
  if (url.pathname === '/health' && req.method === 'GET') {
    return jsonResponse({ status: 'ok' });
  }

  // List available providers + active provider info
  if (url.pathname === '/api/providers' && req.method === 'GET') {
    const providers = await getAvailableProviders();
    const warmPoolStats = getWarmPool().getStats();
    return jsonResponse({
      providers,
      activeProvider: warmPoolStats.preferredProvider,
    });
  }

  // List available apps
  if (url.pathname === '/api/apps' && req.method === 'GET') {
    try {
      const [apps, settings] = await Promise.all([listApps(), readSettings()]);
      return jsonResponse({
        apps,
        onboardingCompleted: settings.onboardingCompleted,
        language: settings.language,
        provider: settings.provider,
      });
    } catch {
      return errorResponse('Failed to list apps');
    }
  }

  // List desktop shortcuts
  if (url.pathname === '/api/shortcuts' && req.method === 'GET') {
    try {
      const shortcuts = await readShortcuts();
      return jsonResponse({ shortcuts });
    } catch {
      return errorResponse('Failed to list shortcuts');
    }
  }

  // Update settings
  if (url.pathname === '/api/settings' && req.method === 'PATCH') {
    try {
      const body = await req.text();
      if (!body.trim()) {
        return errorResponse('Empty body', 400);
      }
      let partial: Record<string, unknown>;
      try {
        partial = JSON.parse(body);
      } catch {
        return errorResponse('Invalid JSON', 400);
      }

      // Check if provider is changing
      const providerChanging =
        partial.provider !== undefined && partial.provider !== getWarmPool().getPreferredProvider();

      const settings = await updateSettings(partial as any);

      // Reinitialize warm pool when provider changes
      if (providerChanging) {
        const warmPool = getWarmPool();
        await warmPool.cleanup();
        await warmPool.initialize();
      }

      return jsonResponse(settings);
    } catch {
      return errorResponse('Failed to update settings');
    }
  }

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
      const restoreActions = getWindowRestoreActions(messages);
      const contextMessages = getContextRestoreMessages(messages, policy);
      return jsonResponse({ actions: restoreActions, contextMessages });
    } catch {
      return errorResponse('Failed to restore session');
    }
  }

  // Get domain settings
  if (url.pathname === '/api/domains' && req.method === 'GET') {
    try {
      const [allowAllDomains, domains] = await Promise.all([
        isAllDomainsAllowed(),
        readAllowedDomains(),
      ]);
      return jsonResponse({ allowAllDomains, domains });
    } catch {
      return errorResponse('Failed to read domain settings');
    }
  }

  // Update domain settings
  if (url.pathname === '/api/domains' && req.method === 'PATCH') {
    try {
      const body = await req.text();
      if (!body.trim()) {
        return errorResponse('Empty body', 400);
      }
      let partial: { allowAllDomains?: boolean };
      try {
        partial = JSON.parse(body);
      } catch {
        return errorResponse('Invalid JSON', 400);
      }
      if (typeof partial.allowAllDomains === 'boolean') {
        await setAllowAllDomains(partial.allowAllDomains);
      }
      const [allowAllDomains, domains] = await Promise.all([
        isAllDomainsAllowed(),
        readAllowedDomains(),
      ]);
      return jsonResponse({ allowAllDomains, domains });
    } catch {
      return errorResponse('Failed to update domain settings');
    }
  }

  // Pick directory (native folder dialog)
  if (url.pathname === '/api/pick-directory' && req.method === 'POST') {
    try {
      const path = await pickDirectory();
      if (path) {
        return jsonResponse({ path });
      } else {
        return jsonResponse({ path: null, cancelled: true });
      }
    } catch {
      return errorResponse('Failed to open directory picker');
    }
  }

  // Agent stats endpoint
  if (url.pathname === '/api/agents/stats' && req.method === 'GET') {
    const limiterStats = getAgentLimiter().getStats();
    const broadcastStats = getBroadcastCenter().getStats();
    const warmPoolStats = getWarmPool().getStats();
    return jsonResponse({
      agents: limiterStats,
      connections: broadcastStats,
      warmPool: warmPoolStats,
    });
  }

  return null;
}
