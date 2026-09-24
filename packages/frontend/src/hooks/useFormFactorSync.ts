import { useEffect } from 'react';
import { useDesktopStore } from '@/store';
import { MOBILE_MEDIA_QUERY, detectFormFactor, readFormFactorOverride } from '@/lib/formFactor';
import { readOrientation } from '@/lib/device';

/**
 * Keeps `formFactor` in step with the device — rotating a phone into landscape, or
 * unfolding a foldable, crosses the media query — and mirrors it onto
 * `<html data-form-factor>` so CSS Modules can branch on it without a React prop.
 *
 * Keeps `orientation` in step too. It is tracked apart from the form factor because a
 * rotation usually does *not* cross the media query (a phone is coarse and short in
 * both orientations), and that is exactly the change the agent and apps could not see.
 */
export function useFormFactorSync() {
  const formFactor = useDesktopStore((s) => s.formFactor);

  useEffect(() => {
    document.documentElement.dataset.formFactor = formFactor;
  }, [formFactor]);

  useEffect(() => {
    if (typeof globalThis.matchMedia !== 'function') return;
    // Pinned by ?ui= — the media query no longer decides.
    if (readFormFactorOverride()) return;
    const mql = globalThis.matchMedia(MOBILE_MEDIA_QUERY);
    const onChange = () => useDesktopStore.getState().setFormFactor(detectFormFactor(null));
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    const sync = () => {
      const next = readOrientation();
      if (useDesktopStore.getState().orientation !== next) {
        useDesktopStore.getState().setOrientation(next);
      }
    };
    // `resize` covers the browsers without `screen.orientation`, where the reading falls
    // back to the legacy angle or the viewport's aspect.
    const so = globalThis.screen?.orientation;
    so?.addEventListener?.('change', sync);
    window.addEventListener('resize', sync);
    sync();
    return () => {
      so?.removeEventListener?.('change', sync);
      window.removeEventListener('resize', sync);
    };
  }, []);
}
