/**
 * Which shell layout this device gets: the floating-window desktop, or the phone layout
 * where every window is a full-screen card stacked above the command palette.
 *
 * Decided by media query, not user agent. A touch-first pointer is what makes drag-to-move
 * and 6px resize edges unusable, and a narrow viewport is what makes overlapping windows
 * pointless; a UA string says neither. Both conditions together, so a narrow desktop
 * browser window stays a desktop and a tablet in landscape does too.
 *
 * `?ui=mobile` / `?ui=desktop` pins the choice (remembered per browser, `?ui=auto` clears
 * it) — for trying the phone layout in a desktop browser, or escaping it on a big tablet.
 */
import type { FormFactor } from '@yaar/shared';

export type { FormFactor };

export const MOBILE_MEDIA_QUERY =
  '(pointer: coarse) and (max-width: 820px), (pointer: coarse) and (max-height: 500px)';

const OVERRIDE_KEY = 'yaar.ui';

function parseOverride(value: string | null | undefined): FormFactor | 'auto' | null {
  if (value === 'mobile' || value === 'desktop' || value === 'auto') return value;
  return null;
}

/**
 * The pinned form factor, if any. A `?ui=` param wins and is persisted, so the pin
 * survives the reload that drops the query string.
 */
export function readFormFactorOverride(
  search = globalThis.location?.search ?? '',
): FormFactor | null {
  const fromUrl = parseOverride(new URLSearchParams(search).get('ui'));
  try {
    if (fromUrl === 'auto') localStorage.removeItem(OVERRIDE_KEY);
    else if (fromUrl) localStorage.setItem(OVERRIDE_KEY, fromUrl);
  } catch {
    // Storage blocked — the URL param still applies for this load.
  }
  if (fromUrl) return fromUrl === 'auto' ? null : fromUrl;
  try {
    const stored = parseOverride(localStorage.getItem(OVERRIDE_KEY));
    return stored === 'auto' ? null : stored;
  } catch {
    return null;
  }
}

export function detectFormFactor(override = readFormFactorOverride()): FormFactor {
  if (override) return override;
  if (typeof globalThis.matchMedia !== 'function') return 'desktop';
  return globalThis.matchMedia(MOBILE_MEDIA_QUERY).matches ? 'mobile' : 'desktop';
}
