/**
 * Debug slice - the activity log (recent OS actions) and the debug log (every WS frame).
 */
import type { SliceCreator, DebugSlice } from '../types';
import type { OSAction } from '@yaar/shared';

/** How many recent OS actions the activity log keeps, whichever path appended them. */
export const ACTIVITY_LOG_LIMIT = 200;

export const createDebugSlice: SliceCreator<DebugSlice> = (set, _get) => ({
  activityLog: [],
  debugLog: [],

  addToActivityLog: (action: OSAction) =>
    set((state) => {
      state.activityLog.push(action);
      if (state.activityLog.length > ACTIVITY_LOG_LIMIT) {
        state.activityLog = state.activityLog.slice(-ACTIVITY_LOG_LIMIT);
      }
    }),

  addDebugEntry: (entry) =>
    set((state) => {
      const newEntry = {
        ...entry,
        id: `debug-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        timestamp: Date.now(),
      };
      state.debugLog.push(newEntry);
      if (state.debugLog.length > 100) {
        state.debugLog = state.debugLog.slice(-100);
      }
    }),
});
