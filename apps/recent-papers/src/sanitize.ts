import DOMPurify from '@bundled/dompurify';

/**
 * HTML boundary helpers for recent-papers.
 *
 * Every paper field this app renders originates in unauthenticated network JSON
 * (huggingface.co/api/daily_papers, huggingface.co/api/papers/{id}, the arXiv
 * Atom feed) or in agent-supplied recommendations derived from that same data.
 * None of it is trusted. The app builds its own markup from that foreign *text*,
 * so the defect class here is "untrusted text interpolated into an HTML context
 * without encoding" — not "foreign HTML rendered verbatim".
 *
 * Defence is therefore two-layer, applied in the Phase 1.2 order
 * (parse -> sanitize -> rewrite -> insert -> addEventListener):
 *
 *   1. `esc()` / `safeUrl()` at every interpolation point. This is the precise
 *      fix: it makes the markup correct by construction and keeps the source
 *      honest about which values are foreign.
 *   2. `sanitizeMarkup()` on the fully assembled string immediately before it
 *      reaches `innerHTML`. This is the backstop for whatever a future editor
 *      forgets to wrap, and it kills `javascript:` URLs for free.
 */

/** Escape text for use in HTML text nodes and in double-quoted attribute values. */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Validate that a foreign URL is a plain http(s) absolute URL, then escape it
 * for attribute context. Anything else — `javascript:`, `data:`, `vbscript:`,
 * protocol-relative junk, unparseable strings — collapses to `fallback`.
 *
 * We allowlist the protocol rather than leaning on DOMPurify alone because
 * these values feed `href` and `src` directly, and an explicit allowlist is
 * auditable at the call site.
 */
export function safeUrlRaw(value: unknown, fallback = ''): string {
  const raw = String(value ?? '')
    // Strip control characters and whitespace, which browsers ignore inside
    // scheme names ("java\tscript:alert(1)") but naive protocol checks do not.
    .replace(/[\u0000-\u0020\u007f-\u009f]/g, '')
    .trim();
  if (!raw) return fallback;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return fallback;
    return url.href;
  } catch {
    return fallback;
  }
}

/**
 * Attribute-context variant: validated URL, additionally HTML-escaped.
 *
 * Use this when concatenating into a markup string. Do NOT use it for Solid
 * `html` templates or for `setAttribute` — those assign attribute values
 * directly, so pre-escaping would double-encode `&` in real query strings.
 * Use `safeUrlRaw` there.
 */
export function safeUrl(value: unknown, fallback = ''): string {
  return esc(safeUrlRaw(value, fallback));
}

/**
 * Sanitize a fully assembled markup string before it is inserted.
 *
 * The app's own chrome — <article>/<section>/<div class="grid">/<h2>/<h3>,
 * inline `style` on section headings, `class`, `loading="lazy"`,
 * `target`/`rel` on outbound links — is app-authored and must survive, so the
 * allowlists below are explicit rather than default-derived.
 */
export function sanitizeMarkup(markup: string): string {
  return DOMPurify.sanitize(markup, {
    ALLOWED_TAGS: [
      'div',
      'section',
      'article',
      'span',
      'p',
      'h2',
      'h3',
      'strong',
      'em',
      'a',
      'img',
      'br',
    ],
    ALLOWED_ATTR: ['class', 'style', 'href', 'src', 'alt', 'title', 'target', 'rel', 'loading'],
    // NOTE: deliberately NOT narrowing ALLOWED_URI_REGEXP to /^https?:\/\//.
    // DOMPurify applies that regexp to every attribute value that is not in its
    // internal URI_SAFE_ATTRIBUTES set, so narrowing it silently strips
    // `target="_blank"`, `rel="noreferrer"` and `loading="lazy"` — app chrome,
    // not payload. The default regexp already rejects javascript:/data:/
    // vbscript: (including whitespace- and case-obfuscated variants), and the
    // http(s) allowlist we actually rely on lives in `safeUrlRaw` at the
    // interpolation site, which is the precise place to enforce it.
    //
    // NOTE: no FORBID_TAGS/FORBID_ATTR here, deliberately. The allowlists above
    // are exhaustive, so `script`/`iframe`/`form` and `srcset`/`formaction`/
    // `xlink:href` cannot appear by construction — a denylist alongside them
    // would be dead config that reads like load-bearing defence, and the next
    // editor would loosen one believing the other still covered it.
    // Same reason `USE_PROFILES` is absent: it *overrides* ALLOWED_TAGS rather
    // than intersecting with it, which would silently widen this policy.
  }) as unknown as string;
}
