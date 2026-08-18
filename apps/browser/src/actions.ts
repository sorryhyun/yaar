import { app } from '@bundled/yaar';
import { navigate } from '@bundled/yaar-web';
import { activeBrowserId, setLoading, setShowScreenshot } from './store';
import { getScreenshotEl } from './dom';
import { screenshotUrl } from './endpoints';

/** One wording for every fire-and-forget failure, so the console reads consistently. */
function logFailure(what: string, err: unknown): void {
  console.error(`[browser] ${what} failed:`, err);
}

export function refreshScreenshot(fresh = false): void {
  const el = getScreenshotEl();
  if (!el) return;
  setLoading(true);

  el.onload = () => {
    setShowScreenshot(true);
    setLoading(false);
  };
  el.onerror = () => {
    setLoading(false);
  };
  el.src = screenshotUrl(activeBrowserId(), fresh);
}

/** Navigate back/forward — invoke directly for immediate effect, then notify agent. */
export async function handleNav(direction: 'navigate_back' | 'navigate_forward'): Promise<void> {
  const browserId = activeBrowserId();
  try {
    const dir = direction === 'navigate_back' ? 'back' : 'forward';
    await navigate({ direction: dir, browserId });
  } catch (err) {
    logFailure(direction, err);
  }
  app?.sendInteraction({ event: direction });
}

export function handleReload(): void {
  refreshScreenshot(true);
}

export function handleUrlFocus(e: FocusEvent): void {
  (e.target as HTMLInputElement).select();
}

async function navigateDirect(url: string): Promise<void> {
  setLoading(true);
  try {
    await navigate(url, activeBrowserId());
    // SSE will handle screenshot refresh
  } catch (err) {
    logFailure('navigate', err);
  }
}

export function handleUrlKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const input = e.target as HTMLInputElement;
  let url = input.value.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }
  input.value = url;
  input.blur();
  void navigateDirect(url);
  app?.sendInteraction({ event: 'user_navigated', url });
}
