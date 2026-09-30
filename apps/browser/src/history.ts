/**
 * The tab's real session history, as far as the page can report it, and the three
 * toolbar actions that act on it: back, forward, reload.
 *
 * The verb layer can MOVE the tab through its history (`web.navigate({ direction })`)
 * but cannot REPORT it: nothing like CDP's Page.getNavigationHistory is exposed. So the
 * page itself is asked, and it can only partly answer: `history.length` counts every
 * entry, while the Navigation API sees only the contiguous run of same-origin entries
 * around the current one. When the two agree the answer is exact. When they do not,
 * the other-origin entries could sit on either side, so a direction the Navigation API
 * calls impossible reads `null` (unknown) instead, and unknown is treated as allowed:
 * a button wrongly greyed out would block a Back that works, while one wrongly left on
 * costs a click that does nothing.
 *
 * Imports only store.ts, so sse.ts, actions.ts, view.ts and protocol.ts can all reach it.
 */
import { createSignal } from '@bundled/solid-js';
import * as web from '@bundled/yaar-web';
import { activeBrowserId, currentUrl } from './store';

/** `null` = the page could not tell; see the header. */
export interface HistoryReading {
  back: boolean | null;
  forward: boolean | null;
}

const UNKNOWN: HistoryReading = { back: null, forward: null };

const [reading, setReading] = createSignal<HistoryReading>(UNKNOWN);

/** False only when the page's own history proves there is no entry behind it. */
export const canGoBack = (): boolean => reading().back !== false;
export const canGoForward = (): boolean => reading().forward !== false;
/** A real page is loaded; about:blank is the "nothing here yet" state. */
export const canReload = (): boolean => {
  const url = currentUrl();
  return !!url && url !== 'about:blank';
};

/**
 * Runs in the remote page. `entries` is null in a page without the Navigation API.
 * Kept ES5-shaped because it is sent as source text.
 */
const PROBE = `(function () {
  var nav = window.navigation;
  if (!nav || !nav.currentEntry) return { len: history.length, entries: null };
  return { len: history.length, entries: nav.entries().length, back: nav.canGoBack, forward: nav.canGoForward };
})()`;

interface ProbeResult {
  len?: number;
  entries?: number | null;
  back?: boolean;
  forward?: boolean;
}

function interpret(p: ProbeResult | null): HistoryReading {
  if (!p || typeof p.len !== 'number') return UNKNOWN;
  if (p.len <= 1) return { back: false, forward: false };
  if (typeof p.entries !== 'number') return UNKNOWN;
  if (p.entries === p.len) return { back: !!p.back, forward: !!p.forward };
  return { back: p.back ? true : null, forward: p.forward ? true : null };
}

/** Flat envelope: without strictNullChecks the SDK's union does not narrow (AGENTS.md). */
type Envelope = { ok: boolean; data?: unknown; error?: string };

let probeSeq = 0;

/** Re-read the history of `browserId` from its page. A reply that lost a race is dropped. */
export async function refreshHistory(browserId: string): Promise<HistoryReading> {
  const seq = ++probeSeq;
  let next = UNKNOWN;
  try {
    const res = (await web.evaluate({ expression: PROBE, browserId })) as Envelope;
    if (res.ok) next = interpret(res.data as ProbeResult);
  } catch {
    // A tab mid-navigation has no context to evaluate in; the settle probe retries.
  }
  if (seq === probeSeq && activeBrowserId() === browserId) setReading(next);
  return next;
}

const SETTLE_MS = 800;
let settleTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Probe now and again once the page has settled: the SSE url frame arrives at commit,
 * and a history move that lands on an entry with the same URL sends no frame at all.
 */
export function watchHistory(browserId: string): void {
  void refreshHistory(browserId);
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    settleTimer = null;
    if (activeBrowserId() === browserId) void refreshHistory(browserId);
  }, SETTLE_MS);
}

/** Forget the last tab's reading when the window is pointed at another one. */
export function resetHistory(): void {
  probeSeq++;
  setReading(UNKNOWN);
}

export type NavResult = { ok: boolean; data?: unknown; error?: string };

/**
 * Move the real tab one entry back or forward. `recheck` re-reads the page first; the
 * toolbar skips it because its buttons are already disabled from the live reading.
 */
export async function stepHistory(
  direction: 'back' | 'forward',
  browserId: string,
  recheck: boolean,
): Promise<NavResult> {
  const known = recheck ? await refreshHistory(browserId) : reading();
  if (known[direction] === false) {
    return {
      ok: false,
      error: `No history entry ${direction === 'back' ? 'behind' : 'ahead of'} this page.`,
    };
  }
  const res = (await web.navigate({ direction, browserId })) as NavResult;
  watchHistory(browserId);
  return res;
}

/**
 * Reload the real tab. `location.reload()` is deferred a tick so the evaluate call
 * returns before the page's context is torn down under it. A page that refuses
 * evaluation is reloaded by navigating to its own URL instead.
 */
export async function reloadPage(browserId: string): Promise<NavResult> {
  if (!canReload()) return { ok: false, error: 'Nothing is loaded to reload.' };
  const expression = 'setTimeout(function () { location.reload(); }, 0), true';
  let res: NavResult;
  try {
    res = (await web.evaluate({ expression, browserId })) as Envelope;
  } catch (err) {
    res = { ok: false, error: String(err) };
  }
  if (!res.ok) res = (await web.navigate(currentUrl(), browserId)) as NavResult;
  watchHistory(browserId);
  return res.ok ? { ok: true, data: `Reloaded ${currentUrl()}` } : res;
}