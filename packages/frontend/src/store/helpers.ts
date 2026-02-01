/**
 * Helper functions for the desktop store.
 */
import type { UserInteraction } from '@claudeos/shared'
import type { DebugSliceState } from './types'

/**
 * Consolidate consecutive move/resize events into single "from → to" entries.
 * This reduces verbosity when dragging windows.
 */
export function consolidateInteractions(interactions: UserInteraction[]): UserInteraction[] {
  if (interactions.length === 0) return interactions

  const result: UserInteraction[] = []
  let i = 0

  while (i < interactions.length) {
    const current = interactions[i]

    // Only consolidate move and resize events
    if (current.type !== 'window.move' && current.type !== 'window.resize') {
      result.push(current)
      i++
      continue
    }

    // Find the end of consecutive same-type events for the same window
    let j = i + 1
    while (
      j < interactions.length &&
      interactions[j].type === current.type &&
      interactions[j].windowId === current.windowId
    ) {
      j++
    }

    // If there's only one event, keep it as-is
    if (j === i + 1) {
      result.push(current)
      i++
      continue
    }

    // Consolidate: extract first and last positions
    const first = current
    const last = interactions[j - 1]

    // Parse coordinates from details (format: "moved to (x, y)" or "resized to (w, h)")
    const parseCoords = (details?: string): string => {
      const match = details?.match(/\(([^)]+)\)/)
      return match ? match[1] : '?'
    }

    const fromCoords = parseCoords(first.details)
    const toCoords = parseCoords(last.details)
    const verb = current.type === 'window.move' ? 'moved' : 'resized'

    result.push({
      type: current.type,
      timestamp: last.timestamp,
      windowId: current.windowId,
      windowTitle: current.windowTitle,
      details: `${verb} from (${fromCoords}) to (${toCoords})`,
    })

    i = j
  }

  return result
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
