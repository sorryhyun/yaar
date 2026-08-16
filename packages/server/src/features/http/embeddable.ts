/**
 * Embeddability probe — may the desktop frame this URL, or not?
 *
 * `frame-ancestors` (and its predecessor `X-Frame-Options`) is the *target's*
 * policy, enforced by the browser on the target's own document. An embedder has no
 * say in it — no iframe attribute, no sandbox token and no header of ours changes
 * the outcome — and it is not even observable from the outside: the violation
 * belongs to the framed document, and the URI it reports as blocked is *our*
 * origin, not theirs, so the parent gets no event and no error, just a frame that
 * never paints.
 *
 * That leaves asking the site directly, over HTTP, before a window is opened around
 * an iframe that cannot work. The verdict routes the link: framable ones open as an
 * iframe window, refused ones go to the Browser app, which renders a real page
 * server-side and is not framing anything.
 *
 * Every failure mode answers "embeddable" on purpose. A probe that times out, is
 * refused, or is answered by a bot wall says nothing about framing, and guessing
 * "refused" would shunt a perfectly framable site onto the heavier surface — a
 * worse outcome than the status quo, which framed everything.
 */

import { safeFetch, validateUrl } from '../../lib/ssrf.js';

export interface EmbedVerdict {
  embeddable: boolean;
  /** The header that refused, when one did. Absent when embeddable. */
  reason?: string;
}

/** How long to wait for the site to answer before giving up and framing anyway. */
const PROBE_TIMEOUT_MS = 4_000;

/** A verdict is a property of the site's config, which changes on a scale of days. */
const TTL_MS = 10 * 60_000;

/**
 * A probe that failed tells us nothing, so it is cached only long enough to keep a
 * dead host from being re-probed on every click of the same link.
 */
const FAILURE_TTL_MS = 60_000;

const MAX_ENTRIES = 200;

const cache = new Map<string, { verdict: EmbedVerdict; expires: number }>();

/**
 * Does one `frame-ancestors` source expression admit `ancestor`?
 *
 * Sources are matched against the *ancestor* (the desktop), except `'self'`, which
 * names the framed resource's own origin.
 */
function sourceAdmits(source: string, ancestor: URL, resourceOrigin: string): boolean {
  const src = source.trim();
  if (!src) return false;
  if (src === '*') return true;
  if (src.startsWith("'")) {
    // `'self'` is the only keyword with meaning here; `'none'` and the script-oriented
    // keywords admit nobody.
    return src.toLowerCase() === "'self'" && ancestor.origin === resourceOrigin;
  }

  // scheme-source, e.g. `https:`
  if (/^[a-z][a-z0-9+.-]*:$/i.test(src)) {
    return ancestor.protocol.toLowerCase() === src.toLowerCase();
  }

  // host-source: [scheme://]host[:port][/path]
  let rest = src;
  let scheme: string | null = null;
  const withScheme = rest.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (withScheme) {
    scheme = withScheme[1]!.toLowerCase();
    rest = rest.slice(withScheme[0].length);
  }
  // A path in a frame-ancestors source is ignored: framing is decided per origin.
  rest = rest.split('/')[0] ?? '';

  let port: string | null = null;
  const withPort = rest.match(/:(\d+|\*)$/);
  if (withPort) {
    port = withPort[1]!;
    rest = rest.slice(0, -withPort[0].length);
  }
  const host = rest.toLowerCase();
  if (!host) return false;

  if (scheme && `${scheme}:` !== ancestor.protocol.toLowerCase()) return false;

  const ancestorHost = ancestor.hostname.toLowerCase();
  if (host.startsWith('*.')) {
    // `*.example.com` matches a subdomain, never the bare domain.
    if (!ancestorHost.endsWith(host.slice(1))) return false;
  } else if (host !== ancestorHost) {
    return false;
  }

  if (port && port !== '*') {
    const ancestorPort =
      ancestor.port ||
      (ancestor.protocol === 'https:' ? '443' : ancestor.protocol === 'http:' ? '80' : '');
    if (port !== ancestorPort) return false;
  }
  return true;
}

/**
 * Every `frame-ancestors` source list the header declares, one per policy.
 *
 * A response may carry several CSP headers, and `Headers.get` hands them back
 * comma-joined — which is also how a single header expresses several policies, so
 * one split covers both. Each policy is enforced independently: framing has to be
 * admitted by all of them.
 */
function frameAncestorsPolicies(cspHeader: string): string[][] {
  const lists: string[][] = [];
  for (const policy of cspHeader.split(',')) {
    for (const directive of policy.split(';')) {
      const tokens = directive.trim().split(/\s+/).filter(Boolean);
      if (!tokens.length) continue;
      if (tokens[0]!.toLowerCase() !== 'frame-ancestors') continue;
      lists.push(tokens.slice(1));
    }
  }
  return lists;
}

/**
 * Read a response's framing policy. Exported for the tests, which are about this
 * parsing and not about the network.
 */
export function verdictFromHeaders(
  headers: Headers,
  resourceUrl: string,
  ancestorOrigin: string,
): EmbedVerdict {
  let ancestor: URL;
  try {
    ancestor = new URL(ancestorOrigin);
  } catch {
    return { embeddable: true };
  }
  let resourceOrigin: string;
  try {
    resourceOrigin = new URL(resourceUrl).origin;
  } catch {
    resourceOrigin = '';
  }

  const csp = headers.get('content-security-policy');
  const policies = csp ? frameAncestorsPolicies(csp) : [];

  if (policies.length > 0) {
    // CSP supersedes X-Frame-Options wherever both are present, so once a
    // frame-ancestors directive exists it is the whole answer.
    for (const sources of policies) {
      if (!sources.some((s) => sourceAdmits(s, ancestor, resourceOrigin))) {
        return {
          embeddable: false,
          reason: `Content-Security-Policy: frame-ancestors ${sources.join(' ') || "'none'"}`,
        };
      }
    }
    return { embeddable: true };
  }

  const xfo = headers.get('x-frame-options');
  if (xfo) {
    // A comma-joined XFO is two headers disagreeing; the first is as good a read as
    // any, and browsers treat the contradiction as a refusal either way.
    const value = (xfo.split(',')[0] ?? '').trim().toLowerCase();
    if (value === 'deny') {
      return { embeddable: false, reason: 'X-Frame-Options: DENY' };
    }
    if (value === 'sameorigin' && ancestor.origin !== resourceOrigin) {
      return { embeddable: false, reason: 'X-Frame-Options: SAMEORIGIN' };
    }
  }

  return { embeddable: true };
}

function cacheGet(key: string): EmbedVerdict | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expires <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.verdict;
}

function cacheSet(key: string, verdict: EmbedVerdict, ttl: number): void {
  if (cache.size >= MAX_ENTRIES) {
    // Insertion order — drop the oldest entry rather than growing without bound.
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, { verdict, expires: Date.now() + ttl });
}

/**
 * Ask `target` whether `ancestorOrigin` may frame it.
 *
 * Throws only on a URL this server refuses to fetch at all (bad scheme, private
 * network) — every other failure resolves to `{ embeddable: true }`.
 */
export async function checkEmbeddable(
  target: string,
  ancestorOrigin: string,
): Promise<EmbedVerdict> {
  validateUrl(target);

  // Keyed by the full URL, not the origin: a site that refuses framing at the root
  // often permits it under an `/embed/` path, and the reverse.
  const key = `${ancestorOrigin}|${target}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  try {
    // A GET rather than a HEAD: HEAD is widely unimplemented or answered by a
    // different code path, and the headers that matter here are exactly the ones a
    // site tends to attach to real page responses only.
    const res = await safeFetch(target, {
      method: 'GET',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        // Answer as the browser would be answered — a site that serves a different
        // policy to a non-browser client would otherwise be misread.
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    // Only the headers were ever wanted; releasing the body keeps the probe from
    // pulling a whole page down behind it.
    void res.body?.cancel().catch(() => {});

    const verdict = verdictFromHeaders(res.headers, res.url || target, ancestorOrigin);
    cacheSet(key, verdict, TTL_MS);
    return verdict;
  } catch {
    const verdict: EmbedVerdict = { embeddable: true };
    cacheSet(key, verdict, FAILURE_TTL_MS);
    return verdict;
  }
}

/** Test seam — the cache outlives a single probe by design. */
export function clearEmbeddableCache(): void {
  cache.clear();
}
