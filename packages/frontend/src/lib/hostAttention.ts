/**
 * Whether a person can see the desktop, for a host that keeps the page running out of sight.
 *
 * In a browser `document.visibilityState` answers that. The Android app holds the page
 * `visible` while it is in the background, so that the page goes on answering agents, and
 * then the page's own visibility no longer says whether anyone is looking. The host says it
 * instead (`YaarHost.attended` and its `attention` event). With no such host this is always
 * attended, and visibility keeps its ordinary meaning.
 */
import { hostWith } from './host';

let attended = true;
let started = false;
const listeners = new Set<() => void>();

function set(next: boolean): void {
  if (next === attended) return;
  attended = next;
  for (const fn of listeners) fn();
}

function start(): void {
  if (started) return;
  started = true;
  const host = hostWith('attention');
  if (!host?.attended) return;
  host.on('attention', (payload) => {
    set((payload as { attended?: unknown } | null)?.attended !== false);
  });
  // The event reports changes only, and a page can load while already out of sight.
  host.attended().then(set, () => {});
}

/** Running, with nobody looking. False wherever the host cannot say. */
export function isUnattended(): boolean {
  start();
  return !attended;
}

/** Hear the desktop go out of, or come back into, sight. Returns the unsubscribe. */
export function onAttentionChange(fn: () => void): () => void {
  start();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Tests only: the module holds page-wide state. */
export function resetHostAttentionForTest(): void {
  attended = true;
  started = false;
  listeners.clear();
}
