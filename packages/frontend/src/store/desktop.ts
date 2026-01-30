/**
 * The Desktop Store - where AI decisions become UI reality.
 *
 * When the AI emits an action like:
 *   {"type": "window.create", "windowId": "w1", "title": "Hello", ...}
 *
 * This store processes it and updates the state, causing React to render
 * the new window. The AI literally controls what appears on screen.
 */
import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import type { DesktopState, DesktopActions, WindowModel } from '@/types/state'
import type { UserInteraction } from '@claudeos/shared'

/**
 * Consolidate consecutive move/resize events into single "from → to" entries.
 * This reduces verbosity when dragging windows.
 */
function consolidateInteractions(interactions: UserInteraction[]): UserInteraction[] {
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

const initialState: DesktopState = {
  windows: {},
  zOrder: [],
  focusedWindowId: null,
  notifications: {},
  toasts: {},
  connectionStatus: 'disconnected',
  connectionError: null,
  activityLog: [],
  providerType: null,
  sessionId: null,
  debugLog: [],
  debugPanelOpen: false,
  contextMenu: null,
  sessionsModalOpen: false,
  activeAgents: {},
  windowAgents: {},
  pendingFeedback: [],
  interactionLog: [],
}

export const useDesktopStore = create<DesktopState & DesktopActions>()(
  immer((set, get) => ({
    ...initialState,

    applyAction: (action) => set((state) => {
      // Log all AI actions
      state.activityLog.push(action)

      switch (action.type) {
        // ======== Window Actions ========

        case 'window.create': {
          const window: WindowModel = {
            id: action.windowId,
            title: action.title,
            bounds: { ...action.bounds },
            content: { ...action.content },
            minimized: false,
            maximized: false,
            requestId: action.requestId,
          }
          state.windows[action.windowId] = window
          // Remove from zOrder first to prevent duplicates, then add at top
          state.zOrder = state.zOrder.filter(id => id !== action.windowId)
          state.zOrder.push(action.windowId)
          state.focusedWindowId = action.windowId
          break
        }

        case 'window.close': {
          const win = state.windows[action.windowId]
          const actionAgentId = (action as { agentId?: string }).agentId
          const reqId = (action as { requestId?: string }).requestId
          // Respect lock: only owner agent can close a locked window
          if (win?.locked && win.lockedBy !== actionAgentId) {
            // Send feedback if there's a requestId
            if (reqId) {
              state.pendingFeedback.push({
                requestId: reqId,
                windowId: action.windowId,
                renderer: 'lock',
                success: false,
                error: `Window is locked by agent "${win.lockedBy}". Only the locking agent can modify it.`,
              })
            }
            break
          }
          delete state.windows[action.windowId]
          state.zOrder = state.zOrder.filter(id => id !== action.windowId)
          if (state.focusedWindowId === action.windowId) {
            state.focusedWindowId = state.zOrder[state.zOrder.length - 1] ?? null
          }
          break
        }

        case 'window.focus': {
          if (state.windows[action.windowId]) {
            state.zOrder = state.zOrder.filter(id => id !== action.windowId)
            state.zOrder.push(action.windowId)
            state.focusedWindowId = action.windowId
            state.windows[action.windowId].minimized = false
          }
          break
        }

        case 'window.minimize': {
          if (state.windows[action.windowId]) {
            state.windows[action.windowId].minimized = true
            if (state.focusedWindowId === action.windowId) {
              const visible = state.zOrder.filter(id => !state.windows[id]?.minimized)
              state.focusedWindowId = visible[visible.length - 1] ?? null
            }
          }
          break
        }

        case 'window.maximize': {
          const win = state.windows[action.windowId]
          if (win && !win.maximized) {
            win.previousBounds = { ...win.bounds }
            win.maximized = true
          }
          break
        }

        case 'window.restore': {
          const win = state.windows[action.windowId]
          if (win) {
            if (win.maximized && win.previousBounds) {
              win.bounds = { ...win.previousBounds }
              win.maximized = false
            }
            win.minimized = false
          }
          break
        }

        case 'window.move': {
          const win = state.windows[action.windowId]
          if (win) {
            win.bounds.x = action.x
            win.bounds.y = action.y
          }
          break
        }

        case 'window.resize': {
          const win = state.windows[action.windowId]
          if (win) {
            win.bounds.w = action.w
            win.bounds.h = action.h
          }
          break
        }

        case 'window.setTitle': {
          if (state.windows[action.windowId]) {
            state.windows[action.windowId].title = action.title
          }
          break
        }

        case 'window.setContent': {
          const win = state.windows[action.windowId]
          const actionAgentId = (action as { agentId?: string }).agentId
          const reqId = (action as { requestId?: string }).requestId
          // Respect lock: only owner agent can modify locked window content
          if (win?.locked && win.lockedBy !== actionAgentId) {
            if (reqId) {
              state.pendingFeedback.push({
                requestId: reqId,
                windowId: action.windowId,
                renderer: 'lock',
                success: false,
                error: `Window is locked by agent "${win.lockedBy}". Only the locking agent can modify it.`,
              })
            }
            break
          }
          if (win) {
            win.content = { ...action.content }
          }
          break
        }

        case 'window.updateContent': {
          const win = state.windows[action.windowId]
          const actionAgentId = (action as { agentId?: string }).agentId
          const reqId = (action as { requestId?: string }).requestId
          // Respect lock: only owner agent can update locked window content
          if (win?.locked && win.lockedBy !== actionAgentId) {
            if (reqId) {
              state.pendingFeedback.push({
                requestId: reqId,
                windowId: action.windowId,
                renderer: 'lock',
                success: false,
                error: `Window is currently locked by another agent. Use unlock_window to release the lock before updating.`,
              })
            }
            break
          }
          if (win) {
            const currentData = (win.content.data as string) ?? ''
            switch (action.operation.op) {
              case 'append':
                win.content.data = currentData + (action.operation.data as string)
                break
              case 'prepend':
                win.content.data = (action.operation.data as string) + currentData
                break
              case 'replace':
                win.content.data = action.operation.data
                break
              case 'insertAt': {
                const pos = action.operation.position
                win.content.data = currentData.slice(0, pos) + (action.operation.data as string) + currentData.slice(pos)
                break
              }
              case 'clear':
                win.content.data = ''
                break
            }
            if (action.renderer) {
              win.content.renderer = action.renderer
            }
            // Send success feedback with lock status so agent knows to unlock
            if (reqId && win.locked) {
              state.pendingFeedback.push({
                requestId: reqId,
                windowId: action.windowId,
                renderer: 'lock',
                success: true,
                locked: true,
              })
            }
          }
          break
        }

        // ======== Notification Actions ========

        case 'notification.show': {
          state.notifications[action.id] = {
            id: action.id,
            title: action.title,
            body: action.body,
            icon: action.icon,
            timestamp: Date.now(),
          }
          break
        }

        case 'notification.dismiss': {
          delete state.notifications[action.id]
          break
        }

        // ======== Toast Actions ========

        case 'toast.show': {
          state.toasts[action.id] = {
            id: action.id,
            message: action.message,
            variant: action.variant ?? 'info',
            timestamp: Date.now(),
          }
          break
        }

        case 'toast.dismiss': {
          delete state.toasts[action.id]
          break
        }

        // ======== Window Lock Actions ========

        case 'window.lock': {
          const win = state.windows[action.windowId]
          if (win && !win.locked) {
            win.locked = true
            win.lockedBy = action.agentId
          }
          break
        }

        case 'window.unlock': {
          const win = state.windows[action.windowId]
          if (win && win.locked && win.lockedBy === action.agentId) {
            win.locked = false
            win.lockedBy = undefined
          }
          break
        }
      }
    }),

    applyActions: (actions) => {
      const { applyAction } = get()
      for (const action of actions) {
        applyAction(action)
      }
    },

    setConnectionStatus: (status, error) => set((state) => {
      state.connectionStatus = status
      state.connectionError = error ?? null
    }),

    setSession: (providerType, sessionId) => set((state) => {
      state.providerType = providerType
      state.sessionId = sessionId
    }),

    userFocusWindow: (windowId) => set((state) => {
      const win = state.windows[windowId]
      if (win) {
        state.zOrder = state.zOrder.filter(id => id !== windowId)
        state.zOrder.push(windowId)
        state.focusedWindowId = windowId
        win.minimized = false
        state.interactionLog.push({
          type: 'window.focus',
          timestamp: Date.now(),
          windowId,
          windowTitle: win.title,
        })
      }
    }),

    userCloseWindow: (windowId) => set((state) => {
      const win = state.windows[windowId]
      const title = win?.title
      delete state.windows[windowId]
      state.zOrder = state.zOrder.filter(id => id !== windowId)
      if (state.focusedWindowId === windowId) {
        state.focusedWindowId = state.zOrder[state.zOrder.length - 1] ?? null
      }
      state.interactionLog.push({
        type: 'window.close',
        timestamp: Date.now(),
        windowId,
        windowTitle: title,
      })
    }),

    userMoveWindow: (windowId, x, y) => set((state) => {
      const win = state.windows[windowId]
      if (win) {
        win.bounds.x = x
        win.bounds.y = y
        win.maximized = false
        state.interactionLog.push({
          type: 'window.move',
          timestamp: Date.now(),
          windowId,
          windowTitle: win.title,
          details: `moved to (${x}, ${y})`,
        })
      }
    }),

    userResizeWindow: (windowId, w, h) => set((state) => {
      const win = state.windows[windowId]
      if (win) {
        win.bounds.w = w
        win.bounds.h = h
        win.maximized = false
        state.interactionLog.push({
          type: 'window.resize',
          timestamp: Date.now(),
          windowId,
          windowTitle: win.title,
          details: `resized to (${w}x${h})`,
        })
      }
    }),

    dismissToast: (id) => set((state) => {
      const toast = state.toasts[id]
      delete state.toasts[id]
      state.interactionLog.push({
        type: 'toast.dismiss',
        timestamp: Date.now(),
        details: toast?.message,
      })
    }),

    dismissNotification: (id) => set((state) => {
      const notification = state.notifications[id]
      delete state.notifications[id]
      state.interactionLog.push({
        type: 'notification.dismiss',
        timestamp: Date.now(),
        details: notification?.title,
      })
    }),

    addDebugEntry: (entry) => set((state) => {
      const newEntry = {
        ...entry,
        id: `debug-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        timestamp: Date.now(),
      }
      state.debugLog.push(newEntry)
      // Keep only last 100 entries
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

    showContextMenu: (x, y, windowId?) => set((state) => {
      if (windowId) {
        const win = state.windows[windowId]
        if (win) {
          state.contextMenu = { x, y, windowId, windowTitle: win.title }
        }
      } else {
        // Background or header context menu without specific window content context
        state.contextMenu = { x, y }
      }
    }),

    hideContextMenu: () => set((state) => {
      state.contextMenu = null
    }),

    toggleSessionsModal: () => set((state) => {
      state.sessionsModalOpen = !state.sessionsModalOpen
    }),

    setAgentActive: (agentId, status) => set((state) => {
      state.activeAgents[agentId] = {
        id: agentId,
        status,
        startedAt: state.activeAgents[agentId]?.startedAt ?? Date.now(),
      }
    }),

    clearAgent: (agentId) => set((state) => {
      delete state.activeAgents[agentId]
    }),

    clearAllAgents: () => set((state) => {
      state.activeAgents = {}
    }),

    registerWindowAgent: (windowId, agentId, status) => set((state) => {
      state.windowAgents[windowId] = { agentId, status }
    }),

    updateWindowAgentStatus: (windowId, status) => set((state) => {
      if (state.windowAgents[windowId]) {
        if (status === 'destroyed') {
          delete state.windowAgents[windowId]
        } else {
          state.windowAgents[windowId].status = status
        }
      }
    }),

    removeWindowAgent: (windowId) => set((state) => {
      delete state.windowAgents[windowId]
    }),

    addRenderingFeedback: (feedback) => set((state) => {
      state.pendingFeedback.push(feedback)
    }),

    consumePendingFeedback: () => {
      const feedback = get().pendingFeedback
      if (feedback.length > 0) {
        set((state) => {
          state.pendingFeedback = []
        })
      }
      return feedback
    },

    logInteraction: (interaction) => set((state) => {
      state.interactionLog.push({
        ...interaction,
        timestamp: Date.now(),
      })
      // Keep only last 50 interactions
      if (state.interactionLog.length > 50) {
        state.interactionLog = state.interactionLog.slice(-50)
      }
    }),

    consumeInteractions: () => {
      const interactions = get().interactionLog
      if (interactions.length > 0) {
        set((state) => {
          state.interactionLog = []
        })
      }
      // Consolidate consecutive move/resize events into single "from → to" entries
      return consolidateInteractions(interactions)
    },
  }))
)

// ============ Selectors ============

export const selectWindowsInOrder = (state: DesktopState & DesktopActions) =>
  state.zOrder.map(id => state.windows[id]).filter(Boolean)

export const selectVisibleWindows = (state: DesktopState & DesktopActions) =>
  state.zOrder
    .map(id => state.windows[id])
    .filter((w): w is WindowModel => w != null && !w.minimized)

export const selectToasts = (state: DesktopState & DesktopActions) =>
  Object.values(state.toasts)

export const selectNotifications = (state: DesktopState & DesktopActions) =>
  Object.values(state.notifications)

export const selectActiveAgents = (state: DesktopState & DesktopActions) =>
  Object.values(state.activeAgents)

export const selectWindowAgents = (state: DesktopState & DesktopActions) =>
  state.windowAgents

export const selectWindowAgent = (windowId: string) => (state: DesktopState & DesktopActions) =>
  state.windowAgents[windowId]
