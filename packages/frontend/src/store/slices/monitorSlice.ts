/**
 * Monitor slice - manages virtual desktops (monitors).
 *
 * The monitor *list* is server state: the session owns it, mints the ids, and broadcasts
 * it (`MONITORS`). This slice renders that list and asks the server to change it — it no
 * longer invents monitors. A per-tab counter meant two tabs each minted a monitor "1",
 * collided on one server-side agent, and could not see each other's desktops.
 *
 * `activeMonitorId` stays local, and belongs here: which monitor *this tab* is looking at
 * is a property of this tab. That is exactly the thing the server used to keep one copy
 * of for the whole session, last-writer-wins.
 */
import type { SliceCreator, MonitorSlice, DesktopStore } from '../types';
import { DEFAULT_MONITOR_ID, ClientEventType } from '@yaar/shared';
import { wsManager, sendEvent } from '@/hooks/use-agent-connection/transport-manager';

export const createMonitorSlice: SliceCreator<MonitorSlice> = (set, _get) => ({
  monitors: [{ id: DEFAULT_MONITOR_ID, label: 'Monitor 1', createdAt: Date.now() }],
  activeMonitorId: DEFAULT_MONITOR_ID,

  /** Ask the server for a monitor. The id comes back on MONITORS, with `focus` set. */
  createMonitor: () => {
    if (wsManager.ws?.readyState === WebSocket.OPEN) {
      sendEvent(wsManager, { type: ClientEventType.ADD_MONITOR });
    }
  },

  /** Ask the server to delete a monitor. The list, and the windows, follow on MONITORS. */
  removeMonitor: (id) => {
    if (id === DEFAULT_MONITOR_ID) return;
    if (wsManager.ws?.readyState === WebSocket.OPEN) {
      sendEvent(wsManager, { type: ClientEventType.REMOVE_MONITOR, monitorId: id });
    }
  },

  /**
   * Apply the session's monitor list. Authoritative: monitors the server does not have
   * are gone, and their windows with them.
   */
  setMonitors: (monitors, focus) =>
    set((state) => {
      const known = new Set(monitors.map((m) => m.id));
      const existing = new Map(state.monitors.map((m) => [m.id, m]));
      state.monitors = monitors.map((m) => ({
        id: m.id,
        label: m.label,
        createdAt: existing.get(m.id)?.createdAt ?? Date.now(),
      }));

      // Windows live on a monitor; a monitor the session no longer has cannot have windows.
      const store = state as DesktopStore;
      for (const [windowId, win] of Object.entries(store.windows)) {
        if (!known.has(win.monitorId ?? DEFAULT_MONITOR_ID)) {
          delete store.windows[windowId];
          delete store.queuedActions[windowId];
          store.zOrder = store.zOrder.filter((wid) => wid !== windowId);
        }
      }
      if (store.focusedWindowId && !store.windows[store.focusedWindowId]) {
        store.focusedWindowId = store.zOrder[store.zOrder.length - 1] ?? null;
      }

      // `focus` is set only on the answer to this tab's own ADD_MONITOR.
      if (focus && known.has(focus)) {
        state.activeMonitorId = focus;
      } else if (!known.has(state.activeMonitorId)) {
        // The monitor this tab was on is gone — possibly deleted by another tab.
        state.activeMonitorId = state.monitors[state.monitors.length - 1]?.id ?? DEFAULT_MONITOR_ID;
      }
    }),

  switchMonitor: (id) =>
    set((state) => {
      if (state.monitors.some((m) => m.id === id)) {
        state.activeMonitorId = id;
      }
    }),
});
