/**
 * Shim for @bundled/anime that adds anime.js v3 easing name compatibility.
 *
 * anime.js v4 uses `outCubic`, `inBack`, etc. but v3 (and common convention)
 * uses `easeOutCubic`, `easeInBack`, etc. This shim normalizes `ease*` prefixed
 * names so both formats work transparently.
 */

export * from 'animejs';
import { animate as _animate, eases } from 'animejs';

function normalizeEase(ease: string): string {
  // 'easeOutCubic' → 'outCubic', 'easeInOutBack' → 'inOutBack'
  if (ease.startsWith('ease') && ease.length > 4 && ease[4] >= 'A' && ease[4] <= 'Z') {
    const mapped = ease[4].toLowerCase() + ease.slice(5);
    if (mapped in eases) return mapped;
  }
  return ease;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function animate(targets: any, params: any): ReturnType<typeof _animate> {
  if (params?.ease && typeof params.ease === 'string') {
    return _animate(targets, { ...params, ease: normalizeEase(params.ease) });
  }
  return _animate(targets, params);
}
