/**
 * Device fan-out — the desktop half of `yaar.device` (`iframe-scripts/device-sdk.ts`).
 *
 * A frame asks once as its SDK installs, and is answered on its own `source`: that reply
 * is what reaches an origin-isolated app, which `IframeRenderer` cannot push to on load
 * because it cannot touch the frame's document. After that every change is pushed to
 * every mounted frame.
 */
import { APP_MSG } from '@yaar/shared';
import { WINDOW_ID_DATA_ATTR } from '@/constants/layout';
import { getDesktopStore } from './store-access';
import { postToIframe } from './target';

function deviceUpdate() {
  const { formFactor, orientation } = getDesktopStore().getState();
  return { type: APP_MSG.deviceUpdate, formFactor, orientation };
}

export function initDeviceBroadcaster() {
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.data?.type !== APP_MSG.deviceRequest) return;
    // Nothing in the answer is private to the desktop, so any origin may have it.
    (e.source as Window | null)?.postMessage(deviceUpdate(), '*');
  });

  const store = getDesktopStore();
  let prev = store.getState();
  store.subscribe((state) => {
    if (state.formFactor === prev.formFactor && state.orientation === prev.orientation) return;
    prev = state;
    const message = deviceUpdate();
    const iframes = document.querySelectorAll<HTMLIFrameElement>(`[${WINDOW_ID_DATA_ATTR}] iframe`);
    for (const iframe of iframes) postToIframe(iframe, message);
  });
}
