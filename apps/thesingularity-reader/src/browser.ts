/**
 * browser.ts — Single-session, multi-tab browser management
 *
 * Tab layout:
 *   MAIN_TAB ('main')       — gallery list view + login flow (owns DC cookies)
 *   POST_TAB ('post')        — single reusable post detail view (cookies synced from main)
 */
import * as web from '@bundled/yaar-web';

/** The primary tab: gallery list + login */
export const MAIN_TAB = 'main';

/** Single reusable tab for post detail views */
export const POST_TAB = 'post';

const initialized = new Set<string>();

/** DC domains for cookie operations */
export const DC_COOKIE_URLS = [
  'https://www.dcinside.com/',
  'https://sign.dcinside.com/',
  'https://msign.dcinside.com/',
  'https://accounts.dcinside.com/',
  'https://gall.dcinside.com/',
  'https://m.dcinside.com/',
];

type CookieEntry = { name: string; value: string; domain?: string; path?: string; [k: string]: unknown };

/** Parse raw getCookies response into a flat array */
function parseCookies(raw: unknown): CookieEntry[] {
  if (Array.isArray(raw)) return raw as CookieEntry[];
  if (raw && typeof raw === 'object') {
    const data = (raw as { data?: unknown }).data;
    if (Array.isArray(data)) return data as CookieEntry[];
  }
  return [];
}

/**
 * Open a browser tab (first call) or navigate within it (subsequent calls).
 */
export async function openOrNavigate(
  url: string,
  tabId: string,
  opts: {
    mobile?: boolean;
    visible?: boolean;
    waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  } = {},
): Promise<void> {
  if (initialized.has(tabId)) {
    await web.navigate(url, tabId);
  } else {
    await web.open(url, { browserId: tabId, ...opts });
    initialized.add(tabId);
  }
}

/**
 * Copy DC cookies from MAIN_TAB to a target tab.
 * Call after login and before any authenticated action on a non-main tab.
 */
export async function syncCookiesToTab(targetTabId: string): Promise<void> {
  if (!initialized.has(MAIN_TAB)) return;

  const raw = await web.getCookies({ browserId: MAIN_TAB, urls: DC_COOKIE_URLS });
  const cookies = parseCookies(raw);

  for (const c of cookies) {
    await web.setCookie({
      browserId: targetTabId,
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path ?? '/',
    });
  }
}

/**
 * Close a tab and remove it from the initialized set.
 */
export async function closeTab(tabId: string): Promise<void> {
  if (!initialized.has(tabId)) return;
  try {
    await web.closeTab(tabId);
  } catch {
    /* already closed */
  }
  initialized.delete(tabId);
}
