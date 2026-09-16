/**
 * `GET /api/media-proxy?url=<url>[&referer=<url>]` — same-origin streaming proxy for
 * media, for the `@bundled/yaar-media` SDK.
 *
 * An app playing remote video through `window.fetch` goes via `/api/fetch`, which
 * buffers and base64-encodes the whole body and caps it at 10MB — so a player ends up
 * fetching 2MB Range slices in parallel and decoding each one in JS. This route pipes
 * the upstream body straight out with `Range` forwarded, so `<video src>` can point at
 * it and let the browser do its own buffering and seeking.
 *
 * Gated on the `yaar-media` bundle. A media element cannot set request headers, so the
 * iframe token rides as `?__yaar_token=` (the SDK's `mediaUrl()` puts it there), and
 * the one upstream header a CDN commonly insists on — `Referer` — rides as `?referer=`.
 * No other request header is forwarded, and no cookies: this is not a way around the
 * per-app cookie jar `/api/fetch` keeps.
 */

import { requireBundledApp } from '../access.js';
import { errorResponse, type EndpointMeta } from '../utils.js';
import { streamProxy } from '../../features/http/stream-proxy.js';

export const PUBLIC_ENDPOINTS: EndpointMeta[] = [
  {
    method: 'GET',
    path: '/api/media-proxy?url={url}&referer={url}',
    response: 'file',
    description:
      'Streaming media proxy with Range passthrough (same-origin, no base64). Requires the yaar-media bundle.',
  },
];

/** `referer` must itself be a plain http(s) URL — it becomes an upstream header verbatim. */
export function parseReferer(raw: string | null): string | null | Response {
  if (raw === null || raw === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return errorResponse('Invalid "referer" query parameter', 400);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return errorResponse('"referer" must be an http(s) URL', 400);
  }
  return parsed.href;
}

export async function handleMediaProxyRoutes(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname !== '/api/media-proxy') return null;

  const principal = requireBundledApp(req, url, 'yaar-media');
  if (principal instanceof Response) return principal;

  const target = url.searchParams.get('url');
  if (!target) return errorResponse('Missing "url" query parameter', 400);

  const referer = parseReferer(url.searchParams.get('referer'));
  if (referer instanceof Response) return referer;

  return streamProxy(req, target, {
    purpose: (domain) => `An app wants to stream media from "${domain}".`,
    sessionId: principal.sessionId,
    upstreamHeaders: referer ? { Referer: referer } : undefined,
  });
}
