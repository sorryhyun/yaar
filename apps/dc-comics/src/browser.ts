/**
 * browser.ts — Single-session browser tab management for DC Comics app
 */
import * as web from '@bundled/yaar-web';

export const MAIN_TAB = 'dc-main';
export const POST_TAB = 'dc-post';

const initialized = new Set<string>();

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

export async function closeTab(tabId: string): Promise<void> {
  if (!initialized.has(tabId)) return;
  try {
    await web.closeTab(tabId);
  } catch {
    /* already closed */
  }
  initialized.delete(tabId);
}
