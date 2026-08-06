/**
 * Verb proxy route — exposes a subset of yaar:// verbs to iframe apps.
 *
 * POST /api/verb
 * Body: { verb, uri, payload? }
 * Returns: JSON envelope: { ok: true, data } or { ok: false, error }
 *
 * Access restricted to permissions declared in the app's app.json.
 * Apps without explicit permissions get no verb access.
 * Iframe token auth is reused (X-Iframe-Token header).
 */

import { errorResponse, jsonResponse, parseJsonBody, type EndpointMeta } from '../utils.js';
import { initRegistry } from '../../handlers/index.js';
import { NoActiveSessionError, isEmptyLinkList } from '../../handlers/utils.js';
import type { InvokePayload, Verb, VerbResult } from '../../handlers/uri-registry.js';
import {
  requireBundle,
  requirePermission,
  requireStream,
  resolvePrincipal,
  type Principal,
} from '../access.js';
import { subscriptionRegistry } from '../subscriptions.js';
import { parseAgentStreamUri } from '../../streams/agent-stream.js';
import { getSessionHub } from '../../session/session-hub.js';
import { runWithAgentContext } from '../../agents/agent-context.js';
import { compactVerbPayload, shouldLogVerb } from '../../lib/format-verb-log.js';
import type { SessionId } from '../../session/types.js';

export const PUBLIC_ENDPOINTS: EndpointMeta[] = [
  {
    method: 'POST',
    path: '/api/verb',
    response: 'JSON',
    description:
      'Execute a yaar:// verb from an iframe app. Body: `{ verb, uri, payload? }`, where an ' +
      'invoke `payload` may be an array of payloads to run against the same URI in order ' +
      '(stops at the first failure). Restricted to allowed URI prefixes.',
  },
  {
    method: 'POST',
    path: '/api/verb/subscribe',
    response: 'JSON',
    description:
      'Subscribe/unsubscribe to reactive verb URI updates. Body: `{ uri, action: "subscribe" | "unsubscribe", subscriptionId?, mode?: "change" | "stream", kinds?: string[] }`. `mode: "stream"` pushes typed frames with payloads instead of bare change pings.',
  },
];

const VALID_VERBS: Verb[] = ['describe', 'read', 'list', 'invoke', 'delete'];

interface VerbRequest {
  verb?: string;
  uri?: string;
  /** One payload, or a list to invoke against the same URI in order (`InvokePayload`). */
  payload?: InvokePayload;
}

interface SubscribeRequest {
  uri?: string;
  action?: 'subscribe' | 'unsubscribe';
  subscriptionId?: string;
  /** `'change'` (default) = bare ping; `'stream'` = typed frames with payloads. */
  mode?: 'change' | 'stream';
  /** Stream-only: narrow delivery to these frame kinds. */
  kinds?: string[];
}

/**
 * Try to parse a raw string as JSON, returning the string itself on failure.
 */
function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Transform a VerbResult into a standard JSON envelope for iframe apps.
 *
 * Single-URI results have one text block → `{ ok, data }`.
 * Batch results (from brace expansion) have interleaved URI headers and data blocks
 * produced by formatBatchResults() → `{ ok, data: { [uri]: parsed } }`.
 * Resource blocks → extract embedded text.
 * Resource link blocks → return as array of link objects.
 */
export function toEnvelope(result: VerbResult): Record<string, unknown> {
  // Collect blocks by type
  const textItems: Array<{ type: 'text'; text: string }> = [];
  const images: Array<{ data: string; mimeType: string }> = [];
  const links: Array<{
    uri: string;
    name: string;
    description?: string;
    mimeType?: string;
    kind?: string;
    version?: string;
    size?: number;
    modifiedAt?: string;
  }> = [];

  for (const c of result.content) {
    switch (c.type) {
      case 'text':
        textItems.push(c);
        break;
      case 'image': {
        const img = c as { data: string; mimeType: string };
        images.push({ data: img.data, mimeType: img.mimeType });
        break;
      }
      case 'resource': {
        // Embedded resource → extract text content, treat as text block
        const res = c.resource as { text?: string };
        if (res.text) textItems.push({ type: 'text', text: res.text });
        break;
      }
      case 'resource_link': {
        const link = c as {
          uri: string;
          name: string;
          description?: string;
          mimeType?: string;
          kind?: string;
          version?: string;
          size?: number;
          modifiedAt?: string;
        };
        links.push({
          uri: link.uri,
          name: link.name,
          ...(link.description ? { description: link.description } : {}),
          ...(link.mimeType ? { mimeType: link.mimeType } : {}),
          ...(link.kind ? { kind: link.kind } : {}),
          ...(link.version ? { version: link.version } : {}),
          ...(link.size !== undefined ? { size: link.size } : {}),
          ...(link.modifiedAt ? { modifiedAt: link.modifiedAt } : {}),
        });
        break;
      }
    }
  }

  if (result.isError) {
    const errorTexts = textItems.map((t) => t.text);
    return { ok: false, error: errorTexts.join('\n') };
  }

  // Resource links → return as array of navigable link objects. An empty list is an empty
  // array rather than the `(empty)` placeholder string: a caller that maps over a listing
  // shouldn't have to special-case "no children" as text.
  if (links.length > 0 || isEmptyLinkList(result)) {
    const envelope: Record<string, unknown> = { ok: true, data: links };
    if (images.length > 0) envelope.images = images;
    return envelope;
  }

  // Lossless structured payload (app object/array returns) → hand the typed value
  // straight to the caller instead of re-parsing the (possibly truncated) text block.
  if (result.structuredContent !== undefined) {
    const envelope: Record<string, unknown> = { ok: true, data: result.structuredContent };
    if (images.length > 0) envelope.images = images;
    return envelope;
  }

  // Detect batch results: formatBatchResults() produces "--- uri ---" header blocks
  // interleaved with data blocks.
  const isBatch =
    textItems.length > 1 &&
    textItems[0].text.startsWith('--- ') &&
    textItems[0].text.endsWith(' ---');

  let data: unknown;
  if (isBatch) {
    const batchData: Record<string, unknown> = {};
    let currentUri: string | null = null;
    for (const item of textItems) {
      const headerMatch = item.text.match(/^--- (.+) ---$/);
      if (headerMatch) {
        currentUri = headerMatch[1];
      } else if (currentUri) {
        batchData[currentUri] = tryParseJson(item.text);
        currentUri = null;
      }
    }
    data = batchData;
  } else {
    const raw = textItems[0]?.text ?? '';
    data = tryParseJson(raw);
  }

  const envelope: Record<string, unknown> = { ok: true, data };
  if (images.length > 0) envelope.images = images;
  return envelope;
}

export async function handleVerbRoutes(req: Request, url: URL): Promise<Response | null> {
  // ── Subscribe/unsubscribe endpoint ──
  if (url.pathname === '/api/verb/subscribe' && req.method === 'POST') {
    const body = await parseJsonBody<SubscribeRequest>(req);
    if (body instanceof Response) return body;

    const principal = resolvePrincipal(req, url);
    if (principal instanceof Response) return principal;
    if (principal.kind !== 'app') {
      return errorResponse('Invalid or missing iframe token', 403);
    }

    if (body.action === 'unsubscribe') {
      if (!body.subscriptionId) {
        return errorResponse('Missing "subscriptionId" for unsubscribe', 400);
      }
      subscriptionRegistry.unsubscribe(body.subscriptionId);
      return jsonResponse({ ok: true });
    }

    if (body.action === 'subscribe') {
      if (!body.uri || typeof body.uri !== 'string') {
        return errorResponse('Missing or invalid "uri" field', 400);
      }

      const mode = body.mode === 'stream' ? 'stream' : 'change';
      const kinds = Array.isArray(body.kinds)
        ? body.kinds.filter((k): k is string => typeof k === 'string')
        : undefined;

      // Streaming a sensitive source is gated on the capability that *produces* it,
      // not a plain `read` permission on the resource. `yaar://agents/{id}/stream`
      // is a live transcript, so it takes the `streams:["agents"]`
      // declaration — and the session agent's own stream is shielded outright, since
      // it is the tier that drives the user's real browser. `yaar://dev/*` progress
      // rides the yaar-dev door (the same gate its producer sits behind). Everything
      // else — including a plain change ping, still a subscription to the resource's
      // state — goes through the same read gate as reading it.
      const agentStreamId = mode === 'stream' ? parseAgentStreamUri(body.uri) : null;
      if (agentStreamId) {
        const pool = getSessionHub().get(principal.sessionId)?.getPool();
        const sessionAgentId = pool?.agentPool.getSessionAgent()?.instanceId;
        if (sessionAgentId && sessionAgentId === agentStreamId) {
          return errorResponse('The session agent stream is not subscribable by apps', 403);
        }
        const denied = requireStream(principal, 'agents');
        if (denied) return denied;
      } else if (mode === 'stream' && body.uri.startsWith('yaar://dev/')) {
        const denied = requireBundle(principal, 'yaar-dev');
        if (denied) return denied;
      } else {
        const denied = requirePermission(principal, body.uri, 'read');
        if (denied) return denied;
      }

      // Resolve `self` → real appId so notifyChange() (which fires with real
      // appId URIs) reaches subscriptions made from inside the app's iframe.
      let subscribeUri = body.uri;
      if (body.uri === 'yaar://apps/self' || body.uri.startsWith('yaar://apps/self/')) {
        if (!principal.appId) {
          return errorResponse('Cannot resolve "self": no appId in iframe token', 403);
        }
        subscribeUri =
          body.uri === 'yaar://apps/self'
            ? `yaar://apps/${principal.appId}`
            : body.uri.replace('yaar://apps/self/', `yaar://apps/${principal.appId}/`);
      }

      const subscriptionId = subscriptionRegistry.subscribe(
        principal.token,
        principal.windowId,
        principal.sessionId,
        subscribeUri,
        mode,
        kinds,
      );
      return jsonResponse({ subscriptionId });
    }

    return errorResponse('Invalid "action". Must be "subscribe" or "unsubscribe".', 400);
  }

  // ── Main verb endpoint ──
  if (url.pathname !== '/api/verb' || req.method !== 'POST') {
    return null;
  }

  const body = await parseJsonBody<VerbRequest>(req);
  if (body instanceof Response) return body;

  // Validate verb
  const verb = body.verb as Verb;
  if (!verb || !VALID_VERBS.includes(verb)) {
    return errorResponse(`Invalid verb. Must be one of: ${VALID_VERBS.join(', ')}`, 400);
  }

  // Validate URI
  const uri = body.uri;
  if (!uri || typeof uri !== 'string') {
    return errorResponse('Missing or invalid "uri" field', 400);
  }

  // Resolve the caller. This endpoint is the *app* door — the desktop drives the
  // server over the WebSocket, not through here — so a caller presenting no iframe
  // token is not the host asking a favour, it is an app with nothing declared. It
  // gets nothing but `describe`, which is metadata-only.
  const principal = resolvePrincipal(req, url);
  if (principal instanceof Response) return principal;
  if (principal.kind !== 'app' && verb !== 'describe') {
    return errorResponse('Invalid or missing iframe token', 403);
  }

  const denied = requirePermission(principal, uri, verb);
  if (denied) return denied;

  // `invoke { action: 'copy', from }` reads one URI and writes another, so the write
  // permission checked above covers only half of it. Without this an app permitted to
  // write its own storage could name any source and pull the bytes in — a read grant
  // for the whole tree, spelled as a write. The source is checked under the same rules
  // as reading it directly; `copy` adds no authority, only a cheaper route.
  //
  // Applied per *element*, because a batched invoke is N calls and the registry runs them
  // without coming back through this door — checking only the object form would make the
  // array form the bypass.
  if (verb === 'invoke') {
    for (const element of Array.isArray(body.payload) ? body.payload : [body.payload]) {
      if (element?.action !== 'copy') continue;
      const from = element.from;
      if (typeof from !== 'string') {
        return errorResponse('"from" (a yaar:// storage URI) is required for copy', 400);
      }
      const deniedSource = requirePermission(principal, from, 'read');
      if (deniedSource) return deniedSource;
    }
  }

  const tokenEntry: Extract<Principal, { kind: 'app' }> | null =
    principal.kind === 'app' ? principal : null;

  // Resolve `self` → real appId from iframe token
  let resolvedUri = uri;
  if (uri === 'yaar://apps/self' || uri.startsWith('yaar://apps/self/')) {
    if (!tokenEntry?.appId) {
      return errorResponse('Cannot resolve "self": no appId in iframe token', 403);
    }
    resolvedUri =
      uri === 'yaar://apps/self'
        ? `yaar://apps/${tokenEntry.appId}`
        : uri.replace('yaar://apps/self/', `yaar://apps/${tokenEntry.appId}/`);
  }

  // Log to session logs. Data-plane verbs (an app's proxied fetch) and the devtools
  // console poll are skipped; the rest are summarized — see lib/format-verb-log.ts.
  if (tokenEntry?.sessionId && shouldLogVerb(resolvedUri, body.payload)) {
    const session = getSessionHub().get(tokenEntry.sessionId);
    const logger = session?.getPool()?.getSessionLogger();
    if (logger) {
      const appLabel = tokenEntry.appId ?? 'unknown';
      logger.logToolUse(
        `iframe:${appLabel}`,
        { verb, uri: resolvedUri, ...compactVerbPayload(body.payload) },
        undefined,
      );
    }
  }

  // Dispatch to ResourceRegistry — run within agent context so that handlers
  // (e.g. installApp) can resolve the session via getSessionId() for permission dialogs.
  const registry = initRegistry();
  const sessionId = tokenEntry?.sessionId as SessionId | undefined;
  // The calling iframe's own window pins the monitor it acts on. Without it the
  // context carries no monitor, and everything downstream that scopes by
  // `getMonitorId()` — window creation, raw window-ID resolution — falls back to
  // monitor 0: an app launched from monitor 1's dock would open on monitor 0.
  //
  // The token records that monitor at mint time. Re-deriving it from the window id is
  // only a fallback (older tokens), and a lossy one: raw ids repeat across monitors, so
  // the lookup is ambiguous for any app open on two of them and then yields nothing.
  const callerWindowId = tokenEntry?.windowId;
  const monitorId =
    tokenEntry?.monitorId ??
    (sessionId && callerWindowId
      ? getSessionHub().get(sessionId)?.windowState.getMonitorForWindow(callerWindowId)
      : undefined);
  const dispatch = () => {
    const execute = () => registry.execute(verb, resolvedUri, body.payload);
    return sessionId
      ? runWithAgentContext(
          {
            agentId: `iframe:${tokenEntry?.appId ?? 'unknown'}`,
            sessionId,
            monitorId,
            windowId: callerWindowId,
            appId: tokenEntry?.appId,
            // Read off the *validated token*, never the request body: `systemApp` is a
            // bundled `kind: "system"` app's declared identity (`getAppMeta`), so an app
            // can no more forge it than it can forge the token. It is what lets the
            // registry's session-principal gate admit a system app — the same widening
            // `requirePermission` has always applied to `yaar://session/*`.
            systemApp: tokenEntry?.systemApp,
          },
          execute,
        )
      : execute();
  };

  try {
    return jsonResponse(toEnvelope(await dispatch()));
  } catch (err) {
    if (err instanceof NoActiveSessionError && sessionId) {
      // An app's iframe boots on its own clock: a session-scoped verb can land before
      // the desktop's WebSocket has registered the session (first load after a server
      // start) or while it reconnects. The session reappears under the same id moments
      // later, so hold the request and try once more rather than failing the app's
      // first paint — apps bake their SDK in at compile time, so a client-side retry
      // alone would never reach apps compiled before it existed.
      //
      // Wait *here*, only for a verb that actually asked for the session. Waiting up
      // front (before dispatch) taxed every verb the missing session had no bearing
      // on: `yaar://apps` and `yaar://storage` need no session at all, yet Market Apps
      // paid the full timeout on each one just because its token named an absent id.
      if (await getSessionHub().waitFor(sessionId)) {
        try {
          return jsonResponse(toEnvelope(await dispatch()));
        } catch (retryErr) {
          if (!(retryErr instanceof NoActiveSessionError)) {
            const message = retryErr instanceof Error ? retryErr.message : 'Verb execution failed';
            return errorResponse(message, 500);
          }
        }
      }
    }
    // The session never arrived — the desktop's socket is gone (it stops reconnecting
    // after a handful of tries) or the session was evicted. Say so as a retryable 503;
    // the SDK backs off a couple of times in case a reconnect is still in flight.
    if (err instanceof NoActiveSessionError) {
      console.warn(
        `[verb] ${verb} ${resolvedUri} from iframe:${tokenEntry?.appId ?? 'unknown'} names ` +
          `session ${sessionId ?? '(none)'}, which the hub does not hold — is the desktop connected?`,
      );
      return jsonResponse({ ok: false, error: err.message, retryable: true }, 503);
    }
    const message = err instanceof Error ? err.message : 'Verb execution failed';
    return errorResponse(message, 500);
  }
}
