/**
 * Process <img> tags in post HTML for display.
 * Images should already be base64 data URIs (converted by the browser tab),
 * but this function handles cleanup and fallback for any that weren't converted.
 * - Removes tracking pixels (1×1)
 * - Removes empty/invalid src
 * - Cleans up attributes for proper display
 * - Adds onerror fallback for non-data-URI images that fail to load
 */
export function processImages(htmlStr: string): string {
  const div = document.createElement('div');
  div.innerHTML = htmlStr;
  div.querySelectorAll('img').forEach(img => {
    const src = img.getAttribute('src') ?? '';
    const w = img.getAttribute('width');
    const h = img.getAttribute('height');

    // Remove tiny tracking pixels
    if ((w === '1' || w === '0') && (h === '1' || h === '0')) {
      img.remove();
      return;
    }

    // Remove empty/invalid src images
    if (!src || src === 'about:blank') {
      img.remove();
      return;
    }

    // Clean up attributes
    img.setAttribute('loading', 'lazy');
    img.removeAttribute('onclick');
    img.removeAttribute('width');
    img.removeAttribute('height');

    // For images that weren't converted to data URI, add referrerpolicy + error fallback
    if (!src.startsWith('data:')) {
      img.setAttribute('referrerpolicy', 'no-referrer');
      img.setAttribute('onerror',
        "this.onerror=null;" +
        "var s=document.createElement('span');" +
        "s.textContent='[이미지 로드 실패]';" +
        "s.style.cssText='display:inline-block;padding:4px 8px;" +
        "background:var(--yaar-bg-surface,#2a2a2a);border-radius:4px;" +
        "font-size:0.8em;color:var(--yaar-text-muted,#888);margin:2px';" +
        "this.replaceWith(s)"
      );
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
