/**
 * Debug slice - manages debug panel, activity log, and debug log.
 */
import type { SliceCreator, DebugSlice } from '../types'
import type { OSAction } from '@yaar/shared'

export const createDebugSlice: SliceCreator<DebugSlice> = (set, _get) => ({
  activityLog: [],
  debugLog: [],
  debugPanelOpen: false,
  recentActionsPanelOpen: false,

  addToActivityLog: (action: OSAction) => set((state) => {
    state.activityLog.push(action)
    if (state.activityLog.length > 200) {
      state.activityLog = state.activityLog.slice(-200)
    }
  }),

  addDebugEntry: (entry) => set((state) => {
    const newEntry = {
      ...entry,
      id: `debug-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
    }
    state.debugLog.push(newEntry)
    if (state.debugLog.length > 100) {
      state.debugLog = state.debugLog.slice(-100)
    }
  }),

  toggleDebugPanel: () => set((state) => {
    state.debugPanelOpen = !state.debugPanelOpen
  }),

  clearDebugLog: () => set((state) => {
    state.debugLog = []
  }),

  toggleRecentActionsPanel: () => set((state) => {
    state.recentActionsPanelOpen = !state.recentActionsPanelOpen
  }),

  clearActivityLog: () => set((state) => {
    state.activityLog = []
  }),
})
