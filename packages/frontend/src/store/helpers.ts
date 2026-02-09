/**
 * Helper functions for the desktop store.
 */
import type { DebugSliceState } from './types'

/**
 * Create a monitor-scoped window key for the store.
 * Format: "monitorId/rawWindowId"
 */
export function toWindowKey(monitorId: string, rawId: string): string {
  return `${monitorId}/${rawId}`
}

/**
 * Extract the raw windowId from a (possibly) scoped store key.
 * "monitor-0/win-storage" → "win-storage"
 * "win-storage" → "win-storage" (backward compat)
 */
export function getRawWindowId(key: string): string {
  const idx = key.indexOf('/')
  return idx >= 0 ? key.slice(idx + 1) : key
}

/**
 * Get empty content data for a given renderer type.
 */
export function emptyContentByRenderer(renderer: string): unknown {
  switch (renderer) {
    case 'markdown':
    case 'html':
    case 'text':
      return ''
    case 'table':
      return { headers: [], rows: [] }
    case 'component':
      return ''
    case 'iframe':
      return ''
    default:
      return null
  }
}

/**
 * Add a debug log entry to the state (mutates state via immer).
 */
export function addDebugLogEntry(
  state: DebugSliceState,
  type: string,
  data: unknown,
): void {
  state.debugLog.push({
    id: `debug-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: Date.now(),
    direction: 'in',
    type,
    data,
  })
  if (state.debugLog.length > 100) {
    state.debugLog = state.debugLog.slice(-100)
  }
}
