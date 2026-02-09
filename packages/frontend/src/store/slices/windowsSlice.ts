/**
 * Windows slice - manages windows, z-order, and focus.
 * This is the most complex slice with cross-slice dependencies.
 */
import type { SliceCreator, WindowsSlice, DesktopStore, WindowModel } from '../types'
import type { OSAction } from '@yaar/shared'
import { isContentUpdateOperationValid, isWindowContentData } from '@yaar/shared'
import { emptyContentByRenderer, addDebugLogEntry } from '../helpers'

export const createWindowsSlice: SliceCreator<WindowsSlice> = (set, _get) => ({
  windows: {},
  zOrder: [],
  focusedWindowId: null,

  handleWindowAction: (action: OSAction) => set((state) => {
    const store = state as DesktopStore

    switch (action.type) {
      case 'window.create': {
        const actionMonitorId = (action as { monitorId?: string }).monitorId
        const window: WindowModel = {
          id: action.windowId,
          title: action.title,
          bounds: { ...action.bounds },
          content: { ...action.content },
          minimized: false,
          maximized: false,
          requestId: action.requestId,
          monitorId: actionMonitorId ?? (store as DesktopStore).activeMonitorId ?? 'monitor-0',
        }
        state.windows[action.windowId] = window
        state.zOrder = state.zOrder.filter(id => id !== action.windowId)
        state.zOrder.push(action.windowId)
        state.focusedWindowId = action.windowId
        break
      }

      case 'window.close': {
        const win = state.windows[action.windowId]
        const actionAgentId = (action as { agentId?: string }).agentId
        const reqId = (action as { requestId?: string }).requestId
        if (win?.locked && win.lockedBy !== actionAgentId) {
          if (reqId) {
            store.pendingFeedback.push({
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
        delete store.queuedActions[action.windowId]
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
        if (win?.locked && win.lockedBy !== actionAgentId) {
          if (reqId) {
            store.pendingFeedback.push({
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
        if (win?.locked && win.lockedBy !== actionAgentId) {
          if (reqId) {
            store.pendingFeedback.push({
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
          const targetRenderer = action.renderer ?? win.content.renderer
          const operation = action.operation

          const operationValid = isContentUpdateOperationValid(targetRenderer, operation)

          const applyReplace = (data: unknown) => {
            win.content.data = data
          }

          const applyStringUpdate = (data: string) => {
            const currentData = typeof win.content.data === 'string' ? win.content.data : ''
            switch (operation.op) {
              case 'append':
                win.content.data = currentData + data
                break
              case 'prepend':
                win.content.data = data + currentData
                break
              case 'insertAt': {
                const pos = operation.position
                win.content.data = currentData.slice(0, pos) + data + currentData.slice(pos)
                break
              }
              case 'replace':
                applyReplace(data)
                break
              case 'clear':
                win.content.data = ''
                break
            }
          }

          if (operationValid) {
            if (operation.op === 'clear') {
              win.content.data = emptyContentByRenderer(targetRenderer)
            } else if (operation.op === 'replace') {
              applyReplace(operation.data)
            } else if (typeof operation.data === 'string') {
              applyStringUpdate(operation.data)
            }
          } else {
            addDebugLogEntry(store, 'window.updateContent.invalid', {
              windowId: action.windowId,
              renderer: targetRenderer,
              operation,
            })
            if ('data' in operation && isWindowContentData(targetRenderer, operation.data)) {
              applyReplace(operation.data)
            }
          }

          if (action.renderer && isWindowContentData(targetRenderer, win.content.data)) {
            win.content.renderer = targetRenderer
          }
          if (reqId && win.locked) {
            store.pendingFeedback.push({
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

  userFocusWindow: (windowId) => set((state) => {
    const win = state.windows[windowId]
    if (win) {
      state.zOrder = state.zOrder.filter(id => id !== windowId)
      state.zOrder.push(windowId)
      state.focusedWindowId = windowId
      win.minimized = false
      ;(state as DesktopStore).pendingInteractions.push({
        type: 'window.focus',
        timestamp: Date.now(),
        windowId,
      })
    }
  }),

  userCloseWindow: (windowId) => set((state) => {
    delete state.windows[windowId]
    delete (state as DesktopStore).queuedActions[windowId]
    state.zOrder = state.zOrder.filter(id => id !== windowId)
    if (state.focusedWindowId === windowId) {
      state.focusedWindowId = state.zOrder[state.zOrder.length - 1] ?? null
    }
    ;(state as DesktopStore).pendingInteractions.push({
      type: 'window.close',
      timestamp: Date.now(),
      windowId,
    })
  }),

  userMoveWindow: (windowId, x, y) => set((state) => {
    const win = state.windows[windowId]
    if (win) {
      win.bounds.x = x
      win.bounds.y = y
      win.maximized = false
    }
  }),

  userResizeWindow: (windowId, w, h, x?, y?) => set((state) => {
    const win = state.windows[windowId]
    if (win) {
      win.bounds.w = w
      win.bounds.h = h
      if (x !== undefined) win.bounds.x = x
      if (y !== undefined) win.bounds.y = y
      win.maximized = false
    }
  }),

  // On drag-end / resize-end: push a consolidated interaction with bounds for immediate send
  queueBoundsUpdate: (windowId) => set((state) => {
    const win = state.windows[windowId]
    if (!win) return
    // Replace any existing pending bounds interaction for the same window
    const store = state as DesktopStore
    const idx = store.pendingInteractions.findIndex(
      i => (i.type === 'window.move' || i.type === 'window.resize') && i.windowId === windowId && i.bounds
    )
    const interaction = {
      type: 'window.move' as const,
      timestamp: Date.now(),
      windowId,
      bounds: {
        x: win.bounds.x,
        y: win.bounds.y,
        w: win.bounds.w,
        h: win.bounds.h,
      },
    }
    if (idx >= 0) {
      store.pendingInteractions[idx] = interaction
    } else {
      store.pendingInteractions.push(interaction)
    }
  }),
})
