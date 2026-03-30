/**
 * HTTP fetch handler for the verb layer.
 *
 * Exposes `yaar://http` as a verb resource so iframe apps can use
 * `window.yaar.invoke('yaar://http', { url, method?, headers?, body? })`
 * instead of the legacy `/api/fetch` endpoint.
 */

import type { ResourceRegistry, VerbResult } from './uri-registry.js';
import type { ResolvedUri } from './uri-resolve.js';
import { okJson, error } from './utils.js';
import { performFetch } from '../features/http/fetch.js';
import { getSessionId } from '../agents/agent-context.js';

export function registerHttpHandlers(registry: ResourceRegistry): void {
  registry.register('yaar://http', {
    description:
      'Proxy HTTP requests with SSRF protection and domain allowlist enforcement. ' +
      'Use invoke with { url, method?, headers?, body? }.',
    verbs: ['describe', 'invoke'],
    invokeSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Target URL (required)' },
        method: { type: 'string', description: 'HTTP method (default: GET)' },
        headers: {
          type: 'object',
          description: 'Request headers',
          additionalProperties: { type: 'string' },
        },
        body: { type: 'string', description: 'Request body (for POST/PUT/PATCH)' },
        redirect: {
          type: 'string',
          enum: ['follow', 'manual'],
          description: 'Redirect handling: "follow" (default) or "manual" (return 3xx as-is)',
        },
      },
      required: ['url'],
    },

    async invoke(_resolved: ResolvedUri, payload?: Record<string, unknown>): Promise<VerbResult> {
      const url = payload?.url;
      if (!url || typeof url !== 'string') {
        return error('Missing or invalid "url" field in payload');
      }

      const method = typeof payload?.method === 'string' ? payload.method : undefined;
      const headers =
        payload?.headers && typeof payload.headers === 'object'
          ? (payload.headers as Record<string, string>)
          : undefined;
      const body = typeof payload?.body === 'string' ? payload.body : undefined;
      const redirect =
        typeof payload?.redirect === 'string' && payload.redirect === 'manual'
          ? ('manual' as const)
          : undefined;

      // Use the agent's session context if available, otherwise performFetch
      // will fall back to the default session for permission dialogs.
      const sessionId = getSessionId() ?? undefined;

      try {
        const result = await performFetch(url, { method, headers, body, sessionId, redirect });
        return okJson(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Fetch failed';
        return error(message);
      }
    },
  });
}
