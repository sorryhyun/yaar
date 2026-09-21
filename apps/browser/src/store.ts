import { createSignal, createMemo } from '@bundled/solid-js';
import { createSharedSignal } from '@bundled/yaar';
import { parseHttpUrl } from './url';

const params = new URLSearchParams(window.location.search);

export const initialBrowserId = params.get('browserId') || '0';

/** The `?url=` launch parameter, or `about:blank` when it is absent or not http(s). */
export const parsedInitialUrl = parseHttpUrl(params.get('url') ?? '') ?? 'about:blank';

/**
 * The `?live=1` launch parameter — `web.open(url, { visible: true, live: true })`.
 *
 * Read here but *not* used to seed the `liveMode` signal: `setLive()` returns early
 * when the signal already holds the state it was asked for, so a pre-seeded signal
 * would light the toolbar up and never open the screencast. main.ts calls `setLive(true)`
 * after mount instead, which is the call that actually connects.
 */
export const initialLive = params.get('live') === '1';

const remoteBrowserIdListeners: ((next: string, prev: string) => void)[] = [];

/**
 * Which remote browser/tab this window is driving — set by attach/switch_tab/
 * new_tab/close_tab (session.ts) and by ensureBrowserId's lazy session creation.
 * Shared across copies: every command lands only on the copy the server pinned to
 * answer, but every copy's own SSE/live connection is addressed by this id, so a
 * follower left on the old value would go on streaming a tab the agent moved away
 * from. `session.ts` (which owns connectSSE/connectLive) registers the reconnect
 * via `onRemoteBrowserId` rather than this module reaching for them, to avoid a
 * cycle back into itself.
 */
export const [activeBrowserId, setActiveBrowserId] = createSharedSignal<string>(
  'activeBrowserId',
  initialBrowserId,
  { onRemote: (next, prev) => remoteBrowserIdListeners.forEach((fn) => fn(next, prev)) },
);

/** Run `fn` when another copy of this window points the app at a different browser. */
export function onRemoteBrowserId(fn: (next: string, prev: string) => void): void {
  remoteBrowserIdListeners.push(fn);
}

// currentUrl/pageTitle/showScreenshot are NOT shared: each copy already runs its
// own SSE connection and 200ms poll (see sse.ts) against activeBrowserId, so once
// that id agrees across copies, these converge on their own from the same server
// stream. Sharing them too would mean broadcasting on every poll tick (a copy's
// own <img> load fires up to 5x/sec) — exactly the high-frequency case shared
// signals are not for — and would double-write on every navigation, once from
// each copy's own SSE frame and once from the adopted remote value.
export const [currentUrl, setCurrentUrl] = createSignal(parsedInitialUrl);
export const [pageTitle, setPageTitle] = createSignal('');
export const [loading, setLoading] = createSignal(false);
export const [showScreenshot, setShowScreenshot] = createSignal(false);
export const [placeholderText, setPlaceholderText] = createSignal('Waiting for navigation...');

export interface LockState {
  cls: string;
  icon: string;
}

function getLockState(url: string): LockState {
  if (url === 'about:blank') return { cls: 'lock hidden', icon: '' };
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:'
      ? { cls: 'lock', icon: '🔒' }
      : { cls: 'lock insecure', icon: '🔓' };
  } catch {
    return { cls: 'lock insecure', icon: '🔓' };
  }
}

/** Merged lock state: parses the URL exactly once per render tick via createMemo. */
export const lock = createMemo<LockState>(() => getLockState(currentUrl()));

export function updateUrlBar(url: string, title?: string): void {
  setCurrentUrl(url);
  if (title !== undefined) setPageTitle(title);
}

/** Shared reset helper used by clearDisplay() and attach(). */
export function resetDisplay(placeholder: string): void {
  setShowScreenshot(false);
  setCurrentUrl('about:blank');
  setPageTitle('');
  setPlaceholderText(placeholder);
}

export function clearDisplay(): void {
  resetDisplay('Browser closed.');
}
