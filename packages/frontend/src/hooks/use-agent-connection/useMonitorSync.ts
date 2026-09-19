import { useEffect } from 'react';
import { useDesktopStore } from '@/store';
import { ClientEventType } from '@/types';
import type { SubscribeMonitorEvent } from '@yaar/shared';
import { wsManager, sendEvent } from './transport-manager';

/**
 * The one spelling of "this tab is looking at `monitorId`": which monitor, how big the
 * screen is, and which shell layout it renders. The server sizes new windows from the
 * viewport and tells the monitor agent it is on a phone from the form factor, so every
 * send carries both — including the one on (re)connect.
 */
export function monitorSubscription(monitorId: string): SubscribeMonitorEvent {
  return {
    type: ClientEventType.SUBSCRIBE_MONITOR,
    monitorId,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    formFactor: useDesktopStore.getState().formFactor,
  };
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
          sendEvent(wsManager, monitorSubscription(monitorId));
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
    let previousFormFactor = useDesktopStore.getState().formFactor;

    const unsubscribe = useDesktopStore.subscribe((state) => {
      // A form-factor flip (rotation, `?ui=`) re-reports on the same monitor — the agent's
      // picture of the screen is wrong until it does.
      if (state.activeMonitorId !== previousMonitorId || state.formFactor !== previousFormFactor) {
        previousMonitorId = state.activeMonitorId;
        previousFormFactor = state.formFactor;
        if (wsManager.ws?.readyState === WebSocket.OPEN) {
          sendEvent(wsManager, monitorSubscription(state.activeMonitorId));
          // Deliberately no RESYNC here. Window state and agent streams are delivered
          // session-wide (see LiveSession.broadcast), so a switch has nothing to catch
          // up on — and a snapshot is not free: it mints fresh iframe tokens, which
          // remounts every app iframe, and the remount replays that window's app
          // commands. Side-effectful commands (e.g. memo's addMemo) would run again
          // on every switch.
        }
      }
    });

    return unsubscribe;
  }, []);
}
