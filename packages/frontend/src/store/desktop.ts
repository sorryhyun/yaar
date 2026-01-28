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
          }
          state.windows[action.windowId] = window
          state.zOrder.push(action.windowId)
          state.focusedWindowId = action.windowId
          break
        }

        case 'window.close': {
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
          if (state.windows[action.windowId]) {
            state.windows[action.windowId].content = { ...action.content }
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
      if (state.windows[windowId]) {
        state.zOrder = state.zOrder.filter(id => id !== windowId)
        state.zOrder.push(windowId)
        state.focusedWindowId = windowId
        state.windows[windowId].minimized = false
      }
    }),

    userCloseWindow: (windowId) => set((state) => {
      delete state.windows[windowId]
      state.zOrder = state.zOrder.filter(id => id !== windowId)
      if (state.focusedWindowId === windowId) {
        state.focusedWindowId = state.zOrder[state.zOrder.length - 1] ?? null
      }
    }),

    userMoveWindow: (windowId, x, y) => set((state) => {
      const win = state.windows[windowId]
      if (win) {
        win.bounds.x = x
        win.bounds.y = y
        win.maximized = false
      }
    }),

    userResizeWindow: (windowId, w, h) => set((state) => {
      const win = state.windows[windowId]
      if (win) {
        win.bounds.w = w
        win.bounds.h = h
        win.maximized = false
      }
    }),

    dismissToast: (id) => set((state) => {
      delete state.toasts[id]
    }),

    dismissNotification: (id) => set((state) => {
      delete state.notifications[id]
    }),
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
