/**
 * Device fan-out — the desktop half of `yaar.device` (`iframe-scripts/device-sdk.ts`).
 *
 * A frame asks once as its SDK installs, and is answered on its own `source`: that reply
 * is what reaches an origin-isolated app, which `IframeRenderer` cannot push to on load
 * because it cannot touch the frame's document. After that every change is pushed to
 * every mounted frame.
 *
 * `fullscreen` and `visible` are per window, so every answer is addressed: a frame is told
 * whether *its* card is the full-screen one, and whether *its* window is on screen at all. A
 * frame outside any window gets no answer — every frame the desktop renders sits in one — and
 * keeps the SDK's local guess.
 *
 * `visible` exists because a hidden window's frame never hears it: a minimized window, or
 * one on another monitor, stays mounted under `visibility: hidden` (WindowManager keeps its
 * state alive that way), and `document.visibilityState` inside a frame follows only the
 * top-level page. An app streaming pixels had no way to know nobody was looking.
 *
 * A host that keeps the page running out of sight (`lib/hostAttention.ts`, the Android app)
 * is the same problem one level up: the page stays `visible` in a pocket, so a frame's own
 * `visibilitychange` never fires. Unattended, every window is told it is not visible.
 */
import { APP_MSG, DEFAULT_MONITOR_ID } from '@yaar/shared';
import { WINDOW_ID_DATA_ATTR } from '@/constants/layout';
import { iframeMessages } from '@/lib/iframeMessageRouter';
import { hostSummary } from '@/lib/host';
import { isUnattended, onAttentionChange } from '@/lib/hostAttention';
import { selectFullscreenCardId } from '../selectors';
import type { DesktopStore } from '../types';
import { getDesktopState, getDesktopStore } from './store-access';
import { postToIframe } from './target';

/** The same rule WindowManager hides a window by: minimized, or on another monitor. */
function isShown(state: DesktopStore, windowId: string): boolean {
  const w = state.windows[windowId];
  return !!w && !w.minimized && (w.monitorId ?? DEFAULT_MONITOR_ID) === state.activeMonitorId;
}

/** Which windows are on screen, as one comparable value. */
function shownKey(state: DesktopStore): string {
  return Object.keys(state.windows)
    .filter((id) => isShown(state, id))
    .join('\n');
}

function deviceUpdate(state: DesktopStore, windowId: string | undefined) {
  const { formFactor, orientation } = state;
  const fullscreen = windowId !== undefined && selectFullscreenCardId(state) === windowId;
  const visible = !isUnattended() && (windowId === undefined || isShown(state, windowId));
  // `host` is what the frame is told of the native window — the host itself is main-frame only.
  return {
    type: APP_MSG.deviceUpdate,
    formFactor,
    orientation,
    fullscreen,
    visible,
    host: hostSummary(),
  };
}

function windowIdOf(iframe: HTMLIFrameElement): string | undefined {
  return iframe.closest<HTMLElement>(`[${WINDOW_ID_DATA_ATTR}]`)?.dataset.windowId;
}

function windowFrames() {
  return document.querySelectorAll<HTMLIFrameElement>(`[${WINDOW_ID_DATA_ATTR}] iframe`);
}

export function initDeviceBroadcaster() {
  iframeMessages.on(APP_MSG.deviceRequest, (ctx) => {
    if (!ctx.source) return;
    // Nothing in the answer is private to the desktop, so any origin may have it.
    ctx.source.iframe.contentWindow?.postMessage(
      deviceUpdate(getDesktopState(), ctx.source.windowId),
      '*',
    );
  });

  // Only a frame inside a window can ask, and only for its own window.
  iframeMessages.on(APP_MSG.deviceSetFullscreen, (ctx) => {
    if (!ctx.source) return;
    getDesktopState().requestAppFullscreen(ctx.source.windowId, ctx.data.on === true);
  });

  const store = getDesktopStore();
  let prev = store.getState();
  let prevFullscreen = selectFullscreenCardId(prev);
  let prevShown = shownKey(prev);
  store.subscribe((state) => {
    const fullscreen = selectFullscreenCardId(state);
    // Only recomputed when windows or the monitor changed — a drag replaces `windows`
    // every frame, but leaves this key alone, so nothing is posted for it.
    const shown =
      state.windows === prev.windows && state.activeMonitorId === prev.activeMonitorId
        ? prevShown
        : shownKey(state);
    if (
      state.formFactor === prev.formFactor &&
      state.orientation === prev.orientation &&
      fullscreen === prevFullscreen &&
      shown === prevShown
    ) {
      prev = state;
      return;
    }
    prev = state;
    prevFullscreen = fullscreen;
    prevShown = shown;
    for (const iframe of windowFrames()) {
      postToIframe(iframe, deviceUpdate(state, windowIdOf(iframe)));
    }
  });

  onAttentionChange(() => {
    const state = store.getState();
    for (const iframe of windowFrames()) {
      postToIframe(iframe, deviceUpdate(state, windowIdOf(iframe)));
    }
  });
}
