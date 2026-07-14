import { useEffect } from 'react';
import { useDesktopStore } from '@/store';
import { ClientEventType } from '@/types';
import { wsManager, sendEvent } from './transport-manager';

/** Get current desktop viewport dimensions. */
function getViewport(): { w: number; h: number } {
  return { w: window.innerWidth, h: window.innerHeight };
}

/**
 * Tells the server which monitor this connection is looking at.
 * - Sends SUBSCRIBE_MONITOR when the active monitor changes (includes viewport)
 * - Reports viewport resize to server
 *
 * It no longer announces monitor *creation or deletion* by diffing the local list: the
 * list is the server's now, and the store asks for changes directly (ADD_MONITOR /
 * REMOVE_MONITOR). Diffing a list the server itself just sent us would echo every
 * change back at it — including another tab's.
 */
export function useMonitorSync() {
  // Report viewport on resize (debounced)
  useEffect(() => {
    let resizeTimer: ReturnType<typeof setTimeout>;
    const handleResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const monitorId = useDesktopStore.getState().activeMonitorId;
        if (wsManager.ws?.readyState === WebSocket.OPEN) {
          sendEvent(wsManager, {
            type: ClientEventType.SUBSCRIBE_MONITOR,
            monitorId,
            viewport: getViewport(),
          });
        }
      }, 300);
    };
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      clearTimeout(resizeTimer);
    };
  }, []);

  useEffect(() => {
    let previousMonitorId = useDesktopStore.getState().activeMonitorId;

    const unsubscribe = useDesktopStore.subscribe((state) => {
      if (state.activeMonitorId !== previousMonitorId) {
        previousMonitorId = state.activeMonitorId;
        if (wsManager.ws?.readyState === WebSocket.OPEN) {
          sendEvent(wsManager, {
            type: ClientEventType.SUBSCRIBE_MONITOR,
            monitorId: state.activeMonitorId,
            viewport: getViewport(),
          });
        }
      }
    });

    return unsubscribe;
  }, []);
}
