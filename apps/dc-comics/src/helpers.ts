import DOMPurify from '@bundled/dompurify';

/**
 * Lazy-load attributes used by DCinside mobile (and common lazy-load libs).
 * The real image URL is stored in one of these while `src` is empty or a
 * 1x1/placeholder. Order matters: most specific / most common first.
 */
const LAZY_ATTRS = [
  'data-original',
  'data-src',
  'data-lazy-src',
  'data-lazy',
  'data-echo',
  'data-url',
  'egjs-data-original',
] as const;

/** A src that should be treated as "no real image" (placeholder / blank). */
function isPlaceholderSrc(src: string): boolean {
  if (!src) return true;
  if (src === 'about:blank') return true;
  // tiny transparent gif/png placeholders commonly used for lazy-load
  if (/^data:image\/(gif|png);base64,(R0lGOD|iVBORw0KGgo)/.test(src) && src.length < 200) return true;
  if (/blank\.(gif|png)/i.test(src)) return true;
  if (/(spacer|loading|placeholder|1x1|transparent)\.(gif|png|svg)/i.test(src)) return true;
  // DC-specific lazy/loading placeholders (e.g. dccon_loading_nobg200.png)
  if (/dccon_loading|loading_nobg|_loading_/i.test(src)) return true;
  if (/nstatic\.dcinside\.com\/dc\/m\/img\/.*(loading|blank|no_image|noimage)/i.test(src)) return true;
  return false;
}

/**
 * Resolve the real image URL from an <img>'s lazy-load attributes.
 * Returns the real URL, or the existing src if no lazy attr applies.
 */
function resolveLazyUrl(img: HTMLImageElement): string {
  for (const attr of LAZY_ATTRS) {
    const v = (img.getAttribute(attr) ?? '').trim();
    if (v && !v.startsWith('data:')) return v;
  }
  // data-srcset / srcset: take the first candidate URL
  const srcset = (img.getAttribute('data-srcset') ?? img.getAttribute('srcset') ?? '').trim();
  if (srcset) {
    const first = srcset.split(',')[0]?.trim().split(/\s+/)[0] ?? '';
    if (first && !first.startsWith('data:')) return first;
  }
  return (img.getAttribute('src') ?? '').trim();
}

/** Normalise protocol-relative / relative DC URLs to absolute https URLs. */
export function normalizeUrl(url: string): string {
  if (!url) return url;
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('http://')) return 'https://' + url.slice('http://'.length);
  return url;
}

/** Lazy attribute names exposed so callers can strip them after inlining. */
export const LAZY_IMAGE_ATTRS = LAZY_ATTRS;

/**
 * Process <img> tags in post HTML for display.
 *
 * DCinside mobile lazy-loads body images: the real URL lives in a `data-*`
 * attribute (data-original / data-src / ...) while `src` is empty or a tiny
 * placeholder. This resolves lazy attributes, removes tracking pixels, and adds
 * a referrerpolicy + load-failure fallback for cross-origin image hosts.
 *
 * The incoming HTML is sanitized with DOMPurify before anything else runs.
 *
 * Progressive loading: the first `eagerCount` images keep their real `src` and
 * load immediately. Every image after that is *deferred* — its real URL is
 * stashed in `data-deferred-src`, `src` is set to a 1x1 transparent placeholder,
 * and it gets the `deferred-img` class. The caller (DetailPanel) wires an
 * IntersectionObserver that swaps `data-deferred-src` -> `src` as each image
 * scrolls into view, so image-heavy posts no longer decode/paint everything at
 * once.
 */
const TRANSPARENT_PX =
  'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

/**
 * Marker attribute for images that need the load-failure placeholder.
 * The fallback used to be a generated inline `onerror=` attribute; DOMPurify
 * strips inline handlers unconditionally, so the behaviour is now attached with
 * addEventListener after insertion (see `attachImageErrorFallbacks`).
 */
const IMG_FALLBACK_ATTR = 'data-img-fallback';

/**
 * Replace a failed <img> with the same inline placeholder the old generated
 * `onerror` attribute produced. Built with createElement/textContent rather
 * than an HTML string so nothing re-enters an HTML sink.
 */
function replaceWithFailurePlaceholder(img: HTMLImageElement): void {
  const span = document.createElement('span');
  span.textContent = '[이미지 로드 실패]';
  span.style.display = 'inline-block';
  span.style.padding = '4px 8px';
  span.style.background = 'var(--yaar-bg-surface)';
  span.style.borderRadius = '4px';
  span.style.fontSize = '0.8em';
  span.style.color = 'var(--yaar-text-muted)';
  span.style.margin = '2px';
  img.replaceWith(span);
}

/**
 * Attach the image load-failure fallback to every marked <img> inside `el`.
 * Must be called after the processed HTML has been inserted into the document.
 *
 * `{ once: true }` reproduces the one-shot semantics of the old
 * `this.onerror=null` prelude: a failing replacement can never loop.
 */
export function attachImageErrorFallbacks(el: HTMLElement): void {
  const imgs = Array.from(
    el.querySelectorAll(`img[${IMG_FALLBACK_ATTR}]`),
  ) as HTMLImageElement[];
  for (const img of imgs) {
    img.removeAttribute(IMG_FALLBACK_ATTR);
    img.addEventListener('error', () => replaceWithFailurePlaceholder(img), { once: true });
  }
}

export function processImages(htmlStr: string, eagerCount = 2): string {
  const div = document.createElement('div');
  // SANITIZE FIRST. This is the choke point for all scraped DC HTML: every
  // display path goes through processImages, so sanitizing here guarantees the
  // `div.innerHTML =` parse below never instantiates a live `onerror`/`onload`
  // handler, and the image rewrites that follow operate on a clean fragment.
  //
  // DEVIATION from the baseline (no-options) config used by the OS shell's
  // MarkdownRenderer: DOMPurify's default ALLOWED_TAGS permits <form> and its
  // controls. Post bodies here are read-only scraped forum content where an
  // interactive form has no legitimate purpose, but a <form action="//evil">
  // rendered inside the app chrome is a credential-phishing surface. Forbidden
  // explicitly; everything else stays at the audited defaults.
  div.innerHTML = DOMPurify.sanitize(htmlStr, {
    FORBID_TAGS: ['form', 'input', 'button', 'select', 'textarea', 'option'],
  });
  let kept = 0;
  div.querySelectorAll('img').forEach((img) => {
    const w = img.getAttribute('width');
    const h = img.getAttribute('height');

    // Remove tiny tracking pixels (declared 1x1/0x0)
    if ((w === '1' || w === '0') && (h === '1' || h === '0')) {
      img.remove();
      return;
    }

    const currentSrc = (img.getAttribute('src') ?? '').trim();
    let src = currentSrc;

    // If the current src is missing or a placeholder, pull the real URL from
    // the lazy-load attributes.
    if (isPlaceholderSrc(currentSrc)) {
      const resolved = resolveLazyUrl(img);
      if (resolved && !isPlaceholderSrc(resolved)) {
        src = resolved;
      }
    }

    src = normalizeUrl(src);

    // Still nothing usable -> drop the image
    if (!src || isPlaceholderSrc(src)) {
      img.remove();
      return;
    }

    // Commit the resolved src and strip lazy attributes so they don't override it
    img.setAttribute('src', src);
    for (const attr of LAZY_ATTRS) img.removeAttribute(attr);
    img.removeAttribute('data-srcset');
    img.removeAttribute('srcset');

    // Clean up attributes
    img.setAttribute('loading', 'lazy');
    img.removeAttribute('onclick');
    img.removeAttribute('width');
    img.removeAttribute('height');
    // DC lazy-load classes can re-blank the src via their JS; drop them.
    img.removeAttribute('class');

    // For images that weren't converted to a data URI, the iframe must load them
    // cross-origin. DC's image hosts (dcimg*/viewimage.php) use hotlink
    // protection; sending no referrer is the most reliable way to be allowed
    // from a sandboxed origin. Add a graceful placeholder on failure.
    if (!src.startsWith('data:')) {
      // NOTE: do NOT set crossorigin here. A plain <img> displaying a
      // cross-origin resource is NOT subject to CORS, but adding crossorigin
      // opts the image INTO CORS mode, which DC's image hosts reject (no ACAO
      // header) -> the image is blocked. referrerpolicy alone is safe.
      img.setAttribute('referrerpolicy', 'no-referrer');
      // Mark for the post-insertion error listener. An inline `onerror` string
      // cannot be used here: DOMPurify strips inline handlers, and generating
      // one would violate the "behaviour via addEventListener" contract.
      img.setAttribute(IMG_FALLBACK_ATTR, '');
    }

    // Progressive loading: only the first `eagerCount` images load immediately.
    // The rest are deferred and swapped in by an IntersectionObserver as they
    // scroll into view (see DetailPanel). `loading="lazy"` alone does NOT defer
    // inlined base64 data URIs, so we move the real URL out of `src`.
    kept += 1;
    if (kept > eagerCount) {
      img.setAttribute('data-deferred-src', src);
      img.setAttribute('src', TRANSPARENT_PX);
      img.classList.add('deferred-img');
    }
  });
  return div.innerHTML;
}

export function formatCountdown(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m > 0) return `${m}:${s.toString().padStart(2, '0')}`;
  return `${s}s`;
}

export function formatTime(date: Date | null): string {
  if (!date) return '';
  return date.toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
