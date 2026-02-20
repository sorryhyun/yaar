/**
 * Monitor slice - manages virtual desktops (monitors).
 */
import type { SliceCreator, MonitorSlice, DesktopStore } from '../types';
import { MAX_MONITORS, DEFAULT_MONITOR_ID } from '@/constants/layout';

let monitorCounter = 1;

export const createMonitorSlice: SliceCreator<MonitorSlice> = (set, _get) => ({
  monitors: [{ id: DEFAULT_MONITOR_ID, label: 'Monitor 1', createdAt: Date.now() }],
  activeMonitorId: DEFAULT_MONITOR_ID,

  createMonitor: () => {
    const id = `monitor-${monitorCounter++}`;
    const label = `Monitor ${monitorCounter}`;
    set((state) => {
      if (state.monitors.length >= MAX_MONITORS) return;
      state.monitors.push({ id, label, createdAt: Date.now() });
      state.activeMonitorId = id;
    });
    return id;
  },

  removeMonitor: (id) =>
    set((state) => {
      if (state.monitors.length <= 1) return;
      state.monitors = state.monitors.filter((m) => m.id !== id);

      // Close windows belonging to this monitor
      const store = state as DesktopStore;
      for (const [windowId, win] of Object.entries(store.windows)) {
        if ((win.monitorId ?? 'monitor-0') === id) {
          delete store.windows[windowId];
          delete store.queuedActions[windowId];
          store.zOrder = store.zOrder.filter((wid) => wid !== windowId);
        }
      }

      // Switch to another monitor if active was removed
      if (state.activeMonitorId === id) {
        state.activeMonitorId = state.monitors[state.monitors.length - 1].id;
      }

      // Fix focused window
      const store2 = state as DesktopStore;
      if (store2.focusedWindowId && !store2.windows[store2.focusedWindowId]) {
        store2.focusedWindowId = store2.zOrder[store2.zOrder.length - 1] ?? null;
      }
    }),

  switchMonitor: (id) =>
    set((state) => {
      if (state.monitors.some((m) => m.id === id)) {
        state.activeMonitorId = id;
      }
    }),
});
