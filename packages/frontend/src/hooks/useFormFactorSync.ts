import { useEffect } from 'react';
import { useDesktopStore } from '@/store';
import { MOBILE_MEDIA_QUERY, detectFormFactor, readFormFactorOverride } from '@/lib/formFactor';

/**
 * Keeps `formFactor` in step with the device — rotating a phone into landscape, or
 * unfolding a foldable, crosses the media query — and mirrors it onto
 * `<html data-form-factor>` so CSS Modules can branch on it without a React prop.
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
}
