/**
 * The live tab strip: remote targets the socket can point at, including popups
 * Chrome drew as their own windows.
 */
import { closeTab } from '@bundled/yaar-web';
import { liveTabs, setLiveTabs, liveMode, type LiveTab } from './state';
import { isLiveConnected, send, setDesiredTab, resetFrameClock } from './context';
import { seedCanvas } from './seed';
import { resetStats } from './stats';
import { resetFallback } from './fallback';
import { setActiveBrowserId, activeBrowserId } from '../store';
import { connectSSE, stopPolling } from '../sse';

export function upsertTab(tab: LiveTab): void {
  const tabs = liveTabs();
  const at = tabs.findIndex((t) => t.browserId === tab.browserId);
  if (at < 0) {
    setLiveTabs([...tabs, tab]);
    return;
  }
  const next = tabs.slice();
  next[at] = { ...next[at], url: tab.url || next[at].url, title: tab.title || next[at].title };
  setLiveTabs(next);
}

export function removeTab(browserId: string): void {
  setLiveTabs(liveTabs().filter((tab) => tab.browserId !== browserId));
}

/**
 * The canvas is now showing this tab, so everything else in the app follows it.
 *
 * Without this the URL bar, the reload button and the still-screenshot path would
 * all keep addressing the tab the window opened with — a human typing an address
 * while looking at a popup would navigate the page behind it.
 */
export function followTab(browserId: string, url: string, title: string): void {
  upsertTab({ browserId, url, title });
  if (activeBrowserId() === browserId) return;
  setActiveBrowserId(browserId);
  connectSSE(browserId);
  // `connectSSE` starts the 200 ms still-screenshot poll; live mode is already
  // paying for one encode per frame and must not order a second.
  if (liveMode()) stopPolling();
}

/**
 * Put the canvas on another tab, in place — the socket and its counters survive.
 *
 * The attach on its own changes nothing on screen. Chrome emits a screencast frame
 * only when the page repaints, and a tab being switched back to is sitting still, so
 * the canvas would go on showing the last frame of the tab we left. The seed is what
 * makes the switch visible: a still capture of the tab we asked for, addressed by id,
 * so it is right even before the server has moved the stream. See seed.ts.
 */
export function switchLiveTab(browserId: string): void {
  if (!isLiveConnected()) return;
  setDesiredTab(browserId);
  // Counters are per-tab, not per-connection. Carrying them across a switch is
  // what reported `3 fps / 29333 ms` for a link that was never slow: the window
  // and the unanswered-input mark both spanned the time the *other* tab was on
  // screen, and the first frame after the switch was charged for all of it.
  resetStats();
  resetFrameClock();
  resetFallback();
  send({ t: 'attach', browserId });
  void seedCanvas(browserId);
}

/**
 * Close a tab for real, in the remote browser.
 *
 * The strip is not updated here: the tab disappears when Chrome says its target
 * is gone, which is also what happens when the *page* closes its own popup. One
 * path, so the strip can't disagree with the browser.
 */
export async function closeLiveTab(browserId: string): Promise<void> {
  try {
    await closeTab(browserId);
  } catch (err) {
    console.error('[browser] close tab failed:', err);
  }
}
