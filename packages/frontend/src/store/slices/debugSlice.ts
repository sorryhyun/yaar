/**
 * Debug slice - the activity log (recent OS actions).
 */
import type { SliceCreator } from '../types';
import type { OSAction } from '@yaar/shared';

export interface DebugSliceState {
  activityLog: OSAction[];
}

export interface DebugSliceActions {
  addToActivityLog: (action: OSAction) => void;
}

export type DebugSlice = DebugSliceState & DebugSliceActions;

/** How many recent OS actions the activity log keeps, whichever path appended them. */
export const ACTIVITY_LOG_LIMIT = 200;

/**
 * Record one action. Split from the trim so a batch can append fifty and slice once;
 * `desktop.ts` is the other caller, and the two used to have their own copy each.
 */
export function logActivity(state: DebugSliceState, action: OSAction): void {
  state.activityLog.push(action);
}

export function trimActivityLog(state: DebugSliceState): void {
  if (state.activityLog.length > ACTIVITY_LOG_LIMIT) {
    state.activityLog = state.activityLog.slice(-ACTIVITY_LOG_LIMIT);
  }
}

export const createDebugSlice: SliceCreator<DebugSlice> = (set, _get) => ({
  activityLog: [],

  addToActivityLog: (action: OSAction) =>
    set((state) => {
      logActivity(state, action);
      trimActivityLog(state);
    }),
});
