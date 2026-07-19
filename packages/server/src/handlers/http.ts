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
import { clearJar, jarKey } from '../features/http/cookie-jar.js';
import { getSessionId, getAppId } from '../agents/agent-context.js';

export function registerHttpHandlers(registry: ResourceRegistry): void {
  registry.register('yaar://http', {
    description:
      'Proxy HTTP requests with SSRF protection and domain allowlist enforcement. ' +
      'Use invoke with { url, method?, headers?, body? }. ' +
      "Use delete to drop the caller's stored cookies (call this on logout).",
    verbs: ['describe', 'invoke', 'delete'],
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

    /**
     * Drop every cookie the proxy has stored for this caller.
     *
     * Cross-origin requests are jarred per (session, app), and until this existed
     * the jar's only lifecycle was the iframe token's 24-hour expiry. An app with a
     * login therefore could not fully log out: clearing its own stored session left
     * the upstream service's cookies alive server-side, so later "anonymous"
     * requests still carried them. `delete yaar://http` is the logout door.
     *
     * The key is derived from the caller's own context, never from a payload —
     * an app can only ever clear its own jar.
     */
    async delete(): Promise<VerbResult> {
      const sessionId = getSessionId();
      if (!sessionId) return error('No session context — cannot resolve the cookie jar');

      clearJar(jarKey(sessionId, getAppId()));
      return okJson({ cleared: true });
    },
  });
}
