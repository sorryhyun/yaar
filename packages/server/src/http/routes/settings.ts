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
import { jsonResponse, errorResponse, parseJsonBody, type EndpointMeta } from '../utils.js';
import { requirePermission, resolvePrincipal } from '../access.js';

/**
 * Empty on purpose. These are global switches, not app resources.
 *
 * `PATCH /api/domains {allowAllDomains: true}` disables the domain allowlist for
 * every HTTP fetch, browser navigation, tab control, and ML weight download in the
 * process — one unauthenticated call, no prompt. `PATCH /api/settings` swaps the AI
 * provider and restarts the warm pool. Neither is something an app has any business
 * reaching, so they are off the iframe allowlist entirely, and the permission check
 * below is the second lock rather than the only one.
 *
 * The equivalent capability, for an app that genuinely needs it, is to declare
 * `yaar://config/domains` in app.json and go through POST /api/verb.
 */
export const PUBLIC_ENDPOINTS: EndpointMeta[] = [];

export async function handleSettingsRoutes(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname !== '/api/settings' && url.pathname !== '/api/domains') return null;

  const principal = resolvePrincipal(req, url);
  if (principal instanceof Response) return principal;

  const uri = url.pathname === '/api/settings' ? 'yaar://config/settings' : 'yaar://config/domains';
  const denied = requirePermission(principal, uri, req.method === 'GET' ? 'read' : 'invoke');
  if (denied) return denied;

  // Update settings
  if (url.pathname === '/api/settings' && req.method === 'PATCH') {
    try {
      const partial = await parseJsonBody<Record<string, unknown>>(req);
      if (partial instanceof Response) return partial;

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
      const partial = await parseJsonBody<{ allowAllDomains?: boolean }>(req);
      if (partial instanceof Response) return partial;
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
