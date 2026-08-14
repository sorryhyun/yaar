/**
 * HTTP fetch handler for the verb layer.
 *
 * Exposes `yaar://http` as a verb resource so iframe apps can use
 * `window.yaar.invoke('yaar://http', { url, method?, headers?, body? })`
 * instead of the legacy `/api/fetch` endpoint.
 */

import type { ResourceRegistry, VerbResult } from './uri-registry.js';
import type { ResolvedUri } from './uri-resolve.js';
import { okJson, okWithImages, error } from './utils.js';
import { performFetch } from '../features/http/fetch.js';
import { planResponseBody } from '../features/http/binary-body.js';
import { clearJar, jarKey } from '../features/http/cookie-jar.js';
import { storageWrite } from '../storage/storage-manager.js';
import { getSessionId, getAppId, getAgentRole } from '../agents/agent-context.js';

/**
 * Where a `saveTo` path is allowed to land, and for whom.
 *
 * Only the two principals that already hold `yaar://storage/` outright — the session agent
 * and a monitor agent — and only when the context is not acting as an app. The destination
 * is therefore always the shared tree those callers can already write with
 * `invoke('yaar://storage/…', { action: 'write' })`, which is the point: `saveTo` is a
 * cheaper route to a write they can perform anyway, never a new one. An app iframe holding
 * `yaar://http` and nothing else does not acquire a filesystem through this door, and is
 * told so rather than having the parameter quietly ignored.
 */
function saveToDenial(): string | null {
  const role = getAgentRole();
  if (getAppId() !== undefined || (role !== 'session' && role !== 'monitor')) {
    return (
      '"saveTo" is only available to the session and monitor agents, which already hold ' +
      'yaar://storage/. An app receives the bytes inline — decode the base64 "body" itself.'
    );
  }
  return null;
}

/** Reject anything that is not a plain relative path under the storage root. */
function invalidSaveTo(path: string): string | null {
  if (!path.trim()) return '"saveTo" must be a non-empty storage path, e.g. "downloads/photo.jpg".';
  if (path.startsWith('yaar://') || path.startsWith('/'))
    return '"saveTo" is a path relative to yaar://storage/, not a URI — pass "downloads/photo.jpg".';
  if (path.split('/').includes('..')) return '"saveTo" must not contain "..".';
  return null;
}

export function registerHttpHandlers(registry: ResourceRegistry): void {
  registry.register('yaar://http', {
    description:
      'Proxy HTTP requests with SSRF protection and domain allowlist enforcement. ' +
      'Use invoke with { url, method?, headers?, body?, saveTo? }. ' +
      'Text comes back on "body". A binary response does NOT: an image is returned as an ' +
      'image block, and any other binary body is omitted with its size and a hint, because ' +
      'base64 in a transcript is unreadable and large enough to lose the whole result. ' +
      'Pass saveTo to write the bytes to yaar://storage/ and get the path back instead. ' +
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
        saveTo: {
          type: 'string',
          description:
            'Write the response body to this path under yaar://storage/ instead of returning ' +
            'it inline, and return the stored URI. Relative path, e.g. "downloads/photo.jpg". ' +
            'The way to actually retrieve a binary resource: save it, then read or open that ' +
            'path. Session and monitor agents only.',
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
      const saveTo = typeof payload?.saveTo === 'string' ? payload.saveTo : undefined;

      if (saveTo !== undefined) {
        const denial = saveToDenial() ?? invalidSaveTo(saveTo);
        if (denial) return error(denial);
      }

      // Use the agent's session context if available, otherwise performFetch
      // will fall back to the default session for permission dialogs.
      const sessionId = getSessionId() ?? undefined;

      // An iframe wants the base64 envelope — `responseFromProxyPayload` decodes it back
      // into a real `Response`. A model cannot, so anything running as an agent gets the
      // raw bytes and a shape chosen for it. `getAgentRole()` is what separates them: an
      // agent turn always carries a role, an iframe verb call never does, so the fallback
      // when a role cannot be resolved is the app-compatible shape rather than a broken app.
      const forModel = getAgentRole() !== undefined;
      const raw = forModel || saveTo !== undefined;

      try {
        const result = await performFetch(url, {
          method,
          headers,
          body,
          sessionId,
          redirect,
          raw,
        });
        if (!raw) return okJson(result);

        const { bytes = Buffer.alloc(0), ...meta } = result;
        const { body: _unusedBody, ...envelope } = meta;

        if (saveTo !== undefined) {
          const written = await storageWrite(saveTo, bytes);
          if (!written.success)
            return error(`Fetched ${bytes.length} bytes but could not save them: ${written.error}`);
          return okJson({
            ...envelope,
            saved: { uri: `yaar://storage/${saveTo}`, bytes: bytes.length },
          });
        }

        const saveHint =
          saveToDenial() === null
            ? `Re-run with { saveTo: "downloads/<name>" } to write the bytes to yaar://storage/, then read or open that path.`
            : `Open the URL in a window to view it — this door only carries text back to you.`;
        const plan = await planResponseBody(bytes, result.headers['content-type'] ?? '', saveHint);

        if (plan.kind === 'text') return okJson({ ...envelope, body: plan.text });
        if (plan.kind === 'image')
          return okWithImages(`${plan.note}\n\n${JSON.stringify(envelope, null, 2)}`, [
            { data: plan.data, mimeType: plan.mimeType },
          ]);
        return okJson({
          ...envelope,
          bodyOmitted: true,
          bodyBytes: bytes.length,
          hint: plan.hint,
        });
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
