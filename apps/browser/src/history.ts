/**
 * Where the tab sits in its real session history, and the three toolbar actions that
 * act on it: back, forward, reload.
 *
 * The server holds the answer. It reads the browser's own navigation history, which
 * sees what the page cannot (the other-origin entries, and where the current one sits
 * among them), and repeats `canGoBack` / `canGoForward` on every SSE frame. This module
 * only keeps the last answer for the tab on screen.
 *
 * Before the first frame the reading is `null` (not told yet), and unknown is treated
 * as allowed: a button wrongly greyed out would block a Back that works, while one
 * wrongly left on costs a click the server refuses.
 *
 * Imports only store.ts, so sse.ts, actions.ts, view.ts and protocol.ts can all reach it.
 */
import { createSignal } from '@bundled/solid-js';
import * as web from '@bundled/yaar-web';
import { currentUrl } from './store';

/** `null` = no frame has said yet; see the header. */
export interface HistoryReading {
  back: boolean | null;
  forward: boolean | null;
}

const UNKNOWN: HistoryReading = { back: null, forward: null };

const [reading, setReading] = createSignal<HistoryReading>(UNKNOWN);

/** False only once the server has said there is no entry behind this page. */
export const canGoBack = (): boolean => reading().back !== false;
export const canGoForward = (): boolean => reading().forward !== false;
/** A real page is loaded; about:blank is the "nothing here yet" state. */
export const canReload = (): boolean => {
  const url = currentUrl();
  return !!url && url !== 'about:blank';
};

/** Take the history answers off an SSE frame. A frame without them leaves each unknown. */
export function noteHistory(frame: { canGoBack?: boolean; canGoForward?: boolean }): void {
  const next: HistoryReading = {
    back: typeof frame.canGoBack === 'boolean' ? frame.canGoBack : null,
    forward: typeof frame.canGoForward === 'boolean' ? frame.canGoForward : null,
  };
  const prev = reading();
  if (prev.back !== next.back || prev.forward !== next.forward) setReading(next);
}

/** Forget the last tab's reading when the window is pointed at another one. */
export function resetHistory(): void {
  setReading(UNKNOWN);
}

/** Flat envelope: without strictNullChecks the SDK's union does not narrow (AGENTS.md). */
export type NavResult = { ok: boolean; data?: unknown; error?: string };

/**
 * Move the real tab one entry back or forward. Not checked against the reading here:
 * the server reads the history itself and refuses a move that has nowhere to go, and
 * its answer cannot be a frame behind the way this one can.
 */
export async function stepHistory(
  direction: 'back' | 'forward',
  browserId: string,
): Promise<NavResult> {
  return (await web.navigate({ direction, browserId })) as NavResult;
}

/** Reload the real tab: the browser's own reload, not a re-navigation to the same URL. */
export async function reloadPage(browserId: string): Promise<NavResult> {
  if (!canReload()) return { ok: false, error: 'Nothing is loaded to reload.' };
  return (await web.reload({ browserId })) as NavResult;
}
