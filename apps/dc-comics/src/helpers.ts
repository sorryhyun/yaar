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
 * a referrerpolicy + onerror fallback for cross-origin image hosts.
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

export function processImages(htmlStr: string, eagerCount = 2): string {
  const div = document.createElement('div');
  div.innerHTML = htmlStr;
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
      img.setAttribute(
        'onerror',
        'this.onerror=null;' +
          "var s=document.createElement('span');" +
          "s.textContent='[이미지 로드 실패]';" +
          "s.style.cssText='display:inline-block;padding:4px 8px;" +
          'background:var(--yaar-bg-surface);border-radius:4px;' +
          "font-size:0.8em;color:var(--yaar-text-muted);margin:2px';" +
          'this.replaceWith(s)',
      );
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
