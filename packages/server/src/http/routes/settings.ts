/**
 * Settings routes — user settings and domain configuration.
 *
 * PATCH /api/settings  — update user settings
 * GET   /api/domains   — get allowed domains
 * PATCH /api/domains   — update domain settings
 */

import { readSettings, updateSettings } from '../../storage/settings.js';
import { getWarmPool } from '../../providers/factory.js';
import {
  readAllowedDomains,
  isAllDomainsAllowed,
  setAllowAllDomains,
} from '../../features/config/domains.js';
import { jsonResponse, errorResponse, type EndpointMeta } from '../utils.js';

export const PUBLIC_ENDPOINTS: EndpointMeta[] = [
  {
    method: 'PATCH',
    path: '/api/settings',
    response: '`Settings`',
    description: 'Update user settings',
  },
  {
    method: 'GET',
    path: '/api/domains',
    response: '`{ allowAllDomains: boolean, domains: string[] }`',
    description: 'Get allowed domain settings',
  },
  {
    method: 'PATCH',
    path: '/api/domains',
    response: '`{ allowAllDomains: boolean, domains: string[] }`',
    description: 'Update domain settings',
  },
];

export async function handleSettingsRoutes(req: Request, url: URL): Promise<Response | null> {
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

      // Check if provider is changing (requires warm pool restart)
      const providerChanging =
        partial.provider !== undefined && partial.provider !== getWarmPool().getPreferredProvider();

      const settings = await updateSettings(
        partial as Partial<Awaited<ReturnType<typeof readSettings>>>,
      );

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

  return null;
}
