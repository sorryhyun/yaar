import { useEffect } from 'react';
import { useDesktopStore } from '@/store';
import { ClientEventType } from '@/types';
import { wsManager, sendEvent } from './transport-manager';

/** Get current desktop viewport dimensions. */
function getViewport(): { w: number; h: number } {
  return { w: window.innerWidth, h: window.innerHeight };
}

/**
 * Keeps the server in sync with monitor changes:
 * - Sends SUBSCRIBE_MONITOR when the active monitor changes (includes viewport)
 * - Sends REMOVE_MONITOR when a monitor is deleted
 * - Reports viewport resize to server
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
    let previousMonitors = useDesktopStore.getState().monitors;
    let previousMonitorIds = new Set(previousMonitors.map((m) => m.id));

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

      // Only rebuild the Set when the monitors array reference changes
      if (state.monitors !== previousMonitors) {
        previousMonitors = state.monitors;
        const currentMonitorIds = new Set(state.monitors.map((m) => m.id));
        if (wsManager.ws?.readyState === WebSocket.OPEN) {
          for (const id of previousMonitorIds) {
            if (!currentMonitorIds.has(id)) {
              sendEvent(wsManager, { type: ClientEventType.REMOVE_MONITOR, monitorId: id });
            }
          }
        }
        previousMonitorIds = currentMonitorIds;
      }
    });

    return unsubscribe;
  }, []);
}
