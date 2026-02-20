import { useEffect } from 'react';
import { useDesktopStore } from '@/store';
import { ClientEventType } from '@/types';
import { wsManager, sendEvent } from './transport-manager';

/**
 * Keeps the server in sync with monitor changes:
 * - Sends SUBSCRIBE_MONITOR when the active monitor changes
 * - Sends REMOVE_MONITOR when a monitor is deleted
 */
export function useMonitorSync() {
  useEffect(() => {
    let previousMonitorId = useDesktopStore.getState().activeMonitorId;
    let previousMonitorIds = new Set(useDesktopStore.getState().monitors.map((m) => m.id));

    const unsubscribe = useDesktopStore.subscribe((state) => {
      if (state.activeMonitorId !== previousMonitorId) {
        previousMonitorId = state.activeMonitorId;
        if (wsManager.ws?.readyState === WebSocket.OPEN) {
          sendEvent(wsManager, {
            type: ClientEventType.SUBSCRIBE_MONITOR,
            monitorId: state.activeMonitorId,
          });
        }
      }

      const currentMonitorIds = new Set(state.monitors.map((m) => m.id));
      if (wsManager.ws?.readyState === WebSocket.OPEN) {
        for (const id of previousMonitorIds) {
          if (!currentMonitorIds.has(id)) {
            sendEvent(wsManager, { type: ClientEventType.REMOVE_MONITOR, monitorId: id });
          }
        }
      }
      previousMonitorIds = currentMonitorIds;
    });

    return unsubscribe;
  }, []);
}
