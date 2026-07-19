/**
 * Notification fan-out — pushes the notification list into every mounted iframe whenever it
 * changes, so apps can render desktop notifications without polling.
 */
import { WINDOW_ID_DATA_ATTR } from '@/constants/layout';
import { getDesktopStore } from './store-access';
import { postToIframe } from './target';

/**
 * Broadcast notification state changes to all iframes via postMessage.
 * Subscribes to the notifications slice and pushes updates reactively.
 */
export function initNotificationBroadcaster() {
  const store = getDesktopStore();
  let prev = store.getState().notifications;
  store.subscribe((state) => {
    if (state.notifications === prev) return;
    prev = state.notifications;
    const items = Object.values(prev);
    // Broadcast, so this addresses every iframe at once rather than resolving one target.
    const iframes = document.querySelectorAll<HTMLIFrameElement>(`[${WINDOW_ID_DATA_ATTR}] iframe`);
    for (const iframe of iframes) {
      postToIframe(iframe, { type: 'yaar:notifications-update', items });
    }
  });
}
