/**
 * UI event handlers and screenshot actions for the Browser app.
 * All functions that touch the DOM screenshotEl or call yaar-web
 * navigation APIs live here.
 */
import { app } from '@bundled/yaar';
import { navigate, navigateBack, navigateForward } from '@bundled/yaar-web';
import { activeBrowserId, setLoading, setShowScreenshot } from './store';

// ── Screenshot DOM ref ──────────────────────────────────────────────

/**
 * Reference to the <img> element set during render.
 * Exported so sse.ts can access it for polling updates.
 */
export let screenshotEl!: HTMLImageElement;

export function setScreenshotEl(el: HTMLImageElement): void {
  screenshotEl = el;
}

// ── Screenshot refresh ──────────────────────────────────────────────

export function refreshScreenshot(fresh = false): void {
  const bid = activeBrowserId();
  const ts = Date.now();
  const src = `/api/browser/${bid}/screenshot?t=${ts}${fresh ? '&fresh' : ''}`;
  setLoading(true);

  screenshotEl.onload = () => {
    setShowScreenshot(true);
    setLoading(false);
  };
  screenshotEl.onerror = () => {
    setLoading(false);
  };
  screenshotEl.src = src;
}

// ── Navigation event handlers ────────────────────────────────────────

/** Navigate back/forward — invoke directly for immediate effect, then notify agent. */
export async function handleNav(direction: 'navigate_back' | 'navigate_forward'): Promise<void> {
  const bid = activeBrowserId();
  try {
    if (direction === 'navigate_back') await navigateBack(bid);
    else await navigateForward(bid);
  } catch (err) {
    console.error('[browser] Nav error:', err);
  }
  app?.sendInteraction({ event: direction });
}

export function handleReload(): void {
  refreshScreenshot(true);
}

export function handleUrlFocus(e: FocusEvent): void {
  (e.target as HTMLInputElement).select();
}

export async function navigateDirect(url: string): Promise<void> {
  const bid = activeBrowserId();
  setLoading(true);
  try {
    await navigate(url, bid);
    // SSE will handle screenshot refresh
  } catch (err) {
    console.error('[browser] Navigate error:', err);
  }
}

export function handleUrlKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter') {
    e.preventDefault();
    let url = (e.target as HTMLInputElement).value.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) {
      url = 'https://' + url;
    }
    (e.target as HTMLInputElement).value = url;
    (e.target as HTMLInputElement).blur();
    navigateDirect(url);
    app?.sendInteraction({ event: 'user_navigated', url });
  }
}
