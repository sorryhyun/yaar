/**
 * Target resolution — how the bridge turns a window id into something it can postMessage to.
 *
 * Every other module in `iframe-bridge/` goes through here for DOM lookup, iframe lookup and
 * target-origin selection. Note that *key* resolution is deliberately not universal: some
 * callers resolve a server-supplied id through the store, others address the DOM by the raw
 * id they were handed. See `resolveTargetKey` for which is which and why.
 */
import { DEFAULT_MONITOR_ID } from '@yaar/shared';
import { WINDOW_ID_DATA_ATTR } from '@/constants/layout';
import { resolveWindowKey } from '../helpers';
import { getDesktopState } from './store-access';

/** srcdoc/about:blank iframes have a "null" origin, requiring '*'. */
export function getIframeTargetOrigin(iframe: HTMLIFrameElement): string {
  try {
    const origin = iframe.contentWindow?.origin;
    if (origin && origin !== 'null') return origin;
  } catch {
    // Cross-origin access blocked
  }
  return '*';
}

/**
 * Find a window's root element by its **exact** DOM key.
 *
 * The caller decides what that key is: a store key from `resolveTargetKey` for ids that
 * arrive from the server, or a raw window id for callers that already hold the rendered id.
 */
export function findWindowElement(key: string): HTMLElement | null {
  return document.querySelector(`[${WINDOW_ID_DATA_ATTR}="${key}"]`) as HTMLElement | null;
}

/**
 * The iframe inside a window element, if it has one.
 *
 * Deliberately does *not* check `contentWindow`: one caller (`resendAppProtocolReady`) only
 * asks whether the iframe is still mounted, while callers that are about to post a message
 * check `contentWindow` themselves.
 */
export function findIframeIn(el: HTMLElement): HTMLIFrameElement | null {
  return el.querySelector('iframe') as HTMLIFrameElement | null;
}

/** Post to an iframe at its correct target origin. No-op if the frame is already gone. */
export function postToIframe(iframe: HTMLIFrameElement, message: unknown): void {
  iframe.contentWindow?.postMessage(message, getIframeTargetOrigin(iframe));
}

/**
 * Resolve a server-supplied window id to its monitor-scoped store key.
 *
 * Only for ids that cross the socket: the server speaks in bare window ids, while the store
 * and the DOM are keyed by `{monitorId}/{windowId}`. Callers that already hold a rendered
 * key (`notifyIframeClose`, `captureWindow`, `resendAppProtocolReady`) must NOT route
 * through here — they address the DOM by the id they were given, and resolving it against
 * the store would change which window they act on.
 */
export function resolveTargetKey(windowId: string): string {
  const state = getDesktopState();
  const monitorId = state.activeMonitorId ?? DEFAULT_MONITOR_ID;
  return resolveWindowKey(state.windows, windowId, monitorId);
}

/**
 * Why a window id did not reach an element, in terms the caller can act on.
 *
 * "Window element not found" was the same sentence for two different faults, and the
 * one that mattered — the desktop and the server holding the same window under
 * different keys, so nothing this tab does will ever reach it — read exactly like the
 * benign one. Naming the resolved key and the keys this client actually holds is what
 * turns that into a report instead of a mystery; the session that produced issue #48
 * spent its whole diagnosis re-deriving it by hand.
 */
export function explainMissingWindow(windowId: string): string {
  const state = getDesktopState();
  const key = resolveTargetKey(windowId);
  if (state.windows[key]) {
    return `Window "${windowId}" is in this desktop's state as "${key}" but has no element in the DOM.`;
  }
  const known = Object.keys(state.windows);
  const sample = known.slice(0, 8).join(', ') + (known.length > 8 ? ', ...' : '');
  return (
    `Window "${windowId}" is not on this desktop: it resolved to "${key}", which no window ` +
    `holds. This client has ${known.length} window(s)${known.length ? `: ${sample}` : ''}. ` +
    `The server and the desktop disagree about this window's handle.`
  );
}

/**
 * Full path from a server-supplied window id to a live, postable iframe.
 *
 * Collapses the identical resolve → element → iframe → `contentWindow` chain shared by the
 * subscription relays. Callers that need to tell "no window" apart from "window without an
 * iframe" (the App Protocol relay reports them as different errors) compose the steps above
 * instead of calling this.
 */
export function resolveTargetIframe(windowId: string): HTMLIFrameElement | null {
  const el = findWindowElement(resolveTargetKey(windowId));
  if (!el) return null;
  const iframe = findIframeIn(el);
  return iframe?.contentWindow ? iframe : null;
}
