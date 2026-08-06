/**
 * Settings routes — user settings and domain configuration.
 *
 * PATCH /api/settings  — update user settings
 * GET   /api/domains   — get allowed domains
 * PATCH /api/domains   — update domain settings
 */

import { applySettings } from '../../features/config/settings.js';
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

  // Update settings — `applySettings` is the one implementation; this route used to
  // carry a second one that validated nothing, detected a provider change against a
  // different source of truth, and told no open desktop that anything had moved.
  if (url.pathname === '/api/settings' && req.method === 'PATCH') {
    try {
      const partial = await parseJsonBody<Record<string, unknown>>(req);
      if (partial instanceof Response) return partial;

      const result = await applySettings(partial);
      if (!result.ok) return errorResponse(result.message, 400);
      return jsonResponse(result.settings);
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
