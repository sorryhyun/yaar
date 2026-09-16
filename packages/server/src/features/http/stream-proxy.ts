/**
 * Same-origin streaming proxy — the body passes through, it is never held.
 *
 * `/api/fetch` answers with a JSON envelope around a base64 body, which is right for an
 * agent reading a page and wrong for bytes a browser consumes as they arrive: the body is
 * buffered on the server, again in the iframe, decoded in a JS loop, and capped at 10MB
 * because of all that. A `<video src>` or an ORT weight file wants the opposite — the
 * upstream stream piped straight out, with `Range` forwarded so the browser can seek.
 *
 * Callers own the gate (which bundle reaches the door); this owns everything that must
 * hold for any caller: the SSRF check, the domain allowlist, a byte ceiling counted over
 * what actually streams, a stall timeout, and a response that cannot run as a document on
 * YAAR's origin.
 */

import { validateUrl, safeFetch } from '@yaar/lib/ssrf';
import { errMessage } from '@yaar/lib/errors';
import { errorResponse } from '../../http/utils.js';
import { extractDomain } from '../config/domains.js';
import { ensureDomainAllowed } from './domain-gate.js';
import { MAX_DOWNLOAD_SIZE, TIMEOUT_MS } from './fetch.js';

export interface StreamProxyOptions {
  /** Shown in the domain-approval dialog, e.g. `An app wants to stream media from "x".` */
  purpose: (domain: string) => string;
  /** Session to ask for domain approval; defaults to the hub's default session. */
  sessionId?: string;
  /** Extra upstream request headers, already vetted by the caller. */
  upstreamHeaders?: Record<string, string>;
  /** Ceiling on streamed bytes per response. */
  maxBytes?: number;
  /** How long one upstream read (or the response headers) may take before aborting. */
  stallMs?: number;
}

const FORWARDED_RESPONSE_HEADERS = [
  'content-length',
  'etag',
  'accept-ranges',
  'content-range',
  'last-modified',
];

/**
 * Types a browser would render or execute when navigated to. The proxy serves on YAAR's
 * own origin, so an upstream `text/html` passed through verbatim is a page an attacker
 * wrote, running as YAAR. `CSP: sandbox` already strips it of script and origin; this is
 * the second lock, so no single header is load-bearing.
 */
const ACTIVE_CONTENT_TYPE =
  /^\s*(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|[a-z]+\/[a-z.+-]*javascript|text\/css)\b/i;

export function safeContentType(upstream: string | null): string {
  if (!upstream || ACTIVE_CONTENT_TYPE.test(upstream)) return 'application/octet-stream';
  return upstream;
}

/**
 * Re-stream `body`, erroring once more than `maxBytes` have passed and aborting when a
 * single read stalls past `stallMs`.
 *
 * The stall timer runs only while a read is pending — not while the consumer is simply
 * not asking. A `<video>` stops pulling once its buffer is full, and that pause is not a
 * dead upstream.
 */
export function limitStream(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  stallMs: number,
  abort: AbortController,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let total = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const timer = setTimeout(() => abort.abort(), stallMs);
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          controller.error(new Error(`Stream exceeded ${maxBytes} bytes`));
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      } finally {
        clearTimeout(timer);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

export async function streamProxy(
  req: Request,
  target: string,
  options: StreamProxyOptions,
): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return errorResponse('Method not allowed', 405);
  }

  try {
    validateUrl(target);
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : 'Invalid URL', 400);
  }

  // An unknown domain is a question for the user, not a 403: on a fresh install the
  // allowlist is empty, and refusing outright would leave the app no way to consent.
  const denial = await ensureDomainAllowed(target, {
    purpose: options.purpose(extractDomain(target)),
    sessionId: options.sessionId,
  });
  if (denial) return errorResponse(denial.message, 403);

  const maxBytes = options.maxBytes ?? MAX_DOWNLOAD_SIZE;
  const stallMs = options.stallMs ?? TIMEOUT_MS;

  const upstreamHeaders: Record<string, string> = { ...options.upstreamHeaders };
  const range = req.headers.get('range');
  if (range) upstreamHeaders['Range'] = range;

  const abort = new AbortController();
  // A client that goes away mid-headers should not leave the upstream request running.
  req.signal?.addEventListener('abort', () => abort.abort(), { once: true });

  let upstream: Response;
  const headerTimer = setTimeout(() => abort.abort(), stallMs);
  try {
    upstream = await safeFetch(target, {
      method: req.method,
      headers: upstreamHeaders,
      signal: abort.signal,
    });
  } catch (err) {
    return errorResponse(`Upstream fetch failed: ${errMessage(err)}`, 502);
  } finally {
    clearTimeout(headerTimer);
  }

  // 416 is the browser's own business (a Range past the end) — pass it through so a
  // media element can recover, rather than turning it into a generic proxy failure.
  if (!upstream.ok && upstream.status !== 416) {
    await upstream.body?.cancel().catch(() => {});
    // A 4xx keeps its status: callers tell "not there" (404, which some CDNs also use as
    // their rate limit) from "forbidden" by it. Only an upstream 5xx becomes a gateway error.
    return errorResponse(
      `Upstream returned ${upstream.status} ${upstream.statusText}`,
      upstream.status < 500 ? upstream.status : 502,
    );
  }

  const declared = Number(upstream.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await upstream.body?.cancel().catch(() => {});
    return errorResponse(`Upstream response too large (max ${maxBytes} bytes)`, 502);
  }

  const headers: Record<string, string> = {
    'Content-Type': safeContentType(upstream.headers.get('content-type')),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'Cache-Control': 'no-store',
    'Access-Control-Expose-Headers': 'Content-Length, ETag, Accept-Ranges, Content-Range',
  };
  for (const h of FORWARDED_RESPONSE_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) headers[h] = v;
  }

  const body =
    req.method === 'HEAD' || !upstream.body
      ? null
      : limitStream(upstream.body, maxBytes, stallMs, abort);
  if (req.method === 'HEAD') await upstream.body?.cancel().catch(() => {});

  return new Response(body, { status: upstream.status, headers });
}
