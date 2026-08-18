/**
 * Which remote browser this window is driving, and the two mode switches that
 * hang off it (live streaming, stream quality).
 *
 * Lives apart from both the view and the protocol because both reach it: a
 * command needs a session id before it can call the verb layer, and the toolbar
 * needs the same switches the agent has.
 */
import * as web from '@bundled/yaar-web';
import { activeBrowserId, setActiveBrowserId, resetDisplay, clearDisplay } from './store';
import { connectSSE, startPolling, stopPolling } from './sse';
import { refreshScreenshot } from './actions';
import {
  liveMode,
  setLiveMode,
  setQuality,
  connectLive,
  disconnectLive,
  focusRemoteKeyboard,
  isLiveConnected,
  switchLiveTab,
  type QualityPreset,
} from './live';

/** Promise lock to prevent double-creation of browser sessions. */
let creatingSession: Promise<string> | null = null;

/**
 * Ensure we have a valid browserId. If none is set (e.g. app opened without
 * ?browserId), lazily create a session via the verb layer with visible:false
 * to avoid opening a duplicate window.
 */
export async function ensureBrowserId(): Promise<string> {
  const current = activeBrowserId();
  if (current && current !== '' && current !== 'new') return current;

  if (creatingSession) return creatingSession;

  creatingSession = (async () => {
    const result = (await web.open('about:blank', { visible: false })) as { browserId?: string };
    const newId = result?.browserId ?? '0';
    setActiveBrowserId(newId);
    connectSSE(newId);
    return newId;
  })();

  try {
    return await creatingSession;
  } finally {
    creatingSession = null;
  }
}

/** The `{ browserId }` option bag every yaar-web call is spread with. */
export async function browserOpts(): Promise<{ browserId: string }> {
  return { browserId: await ensureBrowserId() };
}

/**
 * Attach to a different browser at runtime.
 * Orchestrates store + SSE together (defined here to avoid circular deps).
 */
export function attach(browserId: string): void {
  setActiveBrowserId(browserId);
  resetDisplay('Connecting...');
  connectSSE(browserId);
  if (liveMode()) {
    // `connectSSE` starts the 200 ms still poll, and the two render paths are
    // mutually exclusive (see setLive). This branch used to leave it running:
    // live mode with a socket that is not up yet is reached by switchTab, and
    // nothing downstream of here stops the poll it just started.
    stopPolling();
    connectLive(browserId);
  }
}

/**
 * Enter or leave live mode (pre-P0 spike).
 *
 * The two render paths are mutually exclusive on purpose: the still path polls a
 * fresh WebP every 200 ms, and leaving that running behind a screencast would
 * charge the same page for two encodes and make the frame-rate reading a lie.
 *
 * Stated as "put it in this state" rather than "flip it" because the agent asks
 * for a state (`set_live_mode`) while the toolbar asks for a flip, and a toggle
 * the agent has to read-then-flip races the user's own click.
 */
export async function setLive(enabled: boolean): Promise<void> {
  if (enabled === liveMode()) return;
  setLiveMode(enabled);
  if (enabled) {
    stopPolling();
    connectLive(await ensureBrowserId());
    // Take the keyboard on entry rather than on first click: the anchor is what
    // an IME composes into, and an unfocused one means the first Korean word a
    // user types goes nowhere at all.
    focusRemoteKeyboard();
  } else {
    disconnectLive();
    startPolling(activeBrowserId());
  }
}

/** The toolbar's ◉ Live button. */
export async function toggleLive(): Promise<void> {
  await setLive(!liveMode());
}

// ── Tabs ──────────────────────────────────────────────────────────────
//
// A "tab" is a remote target with a `browserId`, which is also every verb call's
// address — so switching tabs is what decides where `click`, `type` and `extract`
// land. The live strip (live/tabs.ts) is the same set as seen by the screencast;
// this is the whole browser's, which is what an agent needs even with live off.

export interface TabInfo {
  browserId: string;
  url: string;
  title: string;
  /** True for the tab this window is driving — the one every command lands on. */
  active: boolean;
}

/** `listTabs()` answers `{ ok, data: [{ id, url, title, ... }] }`. */
interface RemoteTab {
  id?: string;
  url?: string;
  title?: string;
}

export async function listTabs(): Promise<TabInfo[]> {
  const res = (await web.listTabs()) as { data?: RemoteTab[] };
  const rows = Array.isArray(res?.data) ? res.data : [];
  const active = activeBrowserId();
  return rows.flatMap((tab) =>
    typeof tab?.id === 'string'
      ? [
          {
            browserId: tab.id,
            url: tab.url ?? '',
            title: tab.title ?? '',
            active: tab.id === active,
          },
        ]
      : [],
  );
}

/**
 * Point the window at another tab, and make sure what is on screen is that tab.
 *
 * Both render paths need a forced re-capture here, for the same reason: nothing
 * arrives on its own. A screencast frame is emitted only when the page repaints,
 * and a tab being switched *back* to is sitting still — so the canvas would keep
 * the frame of the tab we left. The still path's poll would likewise serve the
 * server's last capture of a session it has not looked at since.
 */
export async function switchTab(browserId: string): Promise<void> {
  if (liveMode() && isLiveConnected()) {
    // The tab strip's own path: attach the stream, then seed the canvas.
    switchLiveTab(browserId);
    return;
  }
  attach(browserId);
  if (!liveMode()) refreshScreenshot(true);
}

/**
 * A browserId no tab is using.
 *
 * Ids are the caller's to choose — `?browserId=` picks one the same way, and
 * opening a URL against an unused id is what creates the tab.
 */
function freeTabId(taken: Set<string>): string {
  for (let i = 0; i < 100; i++) {
    const id = String(i);
    if (!taken.has(id)) return id;
  }
  return `tab-${Date.now()}`;
}

/** Open a tab of its own and switch to it. */
export async function newTab(url?: string): Promise<TabInfo> {
  const taken = new Set((await listTabs()).map((tab) => tab.browserId));
  const browserId = freeTabId(taken);
  const target = url?.trim() ? url.trim() : 'about:blank';
  await web.open(target, { browserId, visible: false });
  await switchTab(browserId);
  return { browserId, url: target, title: '', active: true };
}

/**
 * Close a tab in the remote browser.
 *
 * Closing the tab being watched would leave the window addressing something that
 * no longer exists, so it moves to whatever is left — through `switchTab`, so the
 * view is re-captured rather than frozen on the tab that just went away.
 */
export async function closeTab(browserId: string): Promise<{ closed: string; active: string }> {
  await web.closeTab(browserId);
  if (activeBrowserId() === browserId) {
    const rest = (await listTabs()).filter((tab) => tab.browserId !== browserId);
    if (rest[0]) await switchTab(rest[0].browserId);
    else clearDisplay();
  }
  return { closed: browserId, active: activeBrowserId() };
}

/**
 * Change the stream's quality preset.
 *
 * Chrome fixes quality and the size cap when the screencast starts, so this
 * reconnects rather than renegotiating — cheap, and the reconnect itself is a
 * useful reading of how long a cold stream takes to show its first pixel.
 */
export function changeQuality(preset: QualityPreset): void {
  setQuality(preset);
  if (liveMode()) connectLive(activeBrowserId());
}
