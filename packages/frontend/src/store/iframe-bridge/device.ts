/**
 * Device fan-out — the desktop half of `yaar.device` (`iframe-scripts/device-sdk.ts`).
 *
 * A frame asks once as its SDK installs, and is answered on its own `source`: that reply
 * is what reaches an origin-isolated app, which `IframeRenderer` cannot push to on load
 * because it cannot touch the frame's document. After that every change is pushed to
 * every mounted frame.
 *
 * `fullscreen` is per window, so every answer is addressed: a frame is told whether *its*
 * card is the full-screen one. A frame outside any window gets no answer — every frame the
 * desktop renders sits in one — and keeps the SDK's local guess.
 */
import { APP_MSG } from '@yaar/shared';
import { WINDOW_ID_DATA_ATTR } from '@/constants/layout';
import { iframeMessages } from '@/lib/iframeMessageRouter';
import { selectFullscreenCardId } from '../selectors';
import type { DesktopStore } from '../types';
import { getDesktopState, getDesktopStore } from './store-access';
import { postToIframe } from './target';

function deviceUpdate(state: DesktopStore, windowId: string | undefined) {
  const { formFactor, orientation } = state;
  const fullscreen = windowId !== undefined && selectFullscreenCardId(state) === windowId;
  return { type: APP_MSG.deviceUpdate, formFactor, orientation, fullscreen };
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
  store.subscribe((state) => {
    const fullscreen = selectFullscreenCardId(state);
    if (
      state.formFactor === prev.formFactor &&
      state.orientation === prev.orientation &&
      fullscreen === prevFullscreen
    )
      return;
    prev = state;
    prevFullscreen = fullscreen;
    for (const iframe of windowFrames()) {
      postToIframe(iframe, deviceUpdate(state, windowIdOf(iframe)));
    }
  });
}
