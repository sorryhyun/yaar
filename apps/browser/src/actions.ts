import { app } from '@bundled/yaar';
import { navigate } from '@bundled/yaar-web';
import { activeBrowserId, setLoading, setShowScreenshot } from './store';
import { getScreenshotEl } from './dom';
import { screenshotUrl } from './endpoints';
import { parseAddress } from './url';

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

/**
 * Navigate the remote tab and let the SSE stream bring the picture back.
 *
 * The loading flag is cleared here only on failure. On success the arriving frame
 * is what clears it (`refreshScreenshot`), and clearing it here would drop the bar
 * while the page is still on its way.
 */
async function navigateDirect(url: string): Promise<void> {
  setLoading(true);
  try {
    await navigate(url, activeBrowserId());
  } catch (err) {
    setLoading(false);
    logFailure('navigate', err);
  }
}

/**
 * Enter in the address bar.
 *
 * An address is navigated here and nowhere else. The app can carry out a page load
 * by itself, so telling the agent about one buys nothing and costs a whole turn --
 * it would wake up only to be told that the navigation it might have performed has
 * already happened. Anything that is *not* an address is a request this app cannot
 * carry out at all, and that, alone, is what the agent is woken for.
 */
export function handleUrlKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const input = e.target as HTMLInputElement;
  const typed = input.value.trim();
  if (!typed) return;

  const url = parseAddress(typed);
  if (url) {
    input.value = url;
    input.blur();
    void navigateDirect(url);
    return;
  }

  app?.sendInteraction({ event: 'user_query', query: typed });
}
