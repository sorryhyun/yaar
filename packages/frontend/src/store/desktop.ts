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
import type { DesktopStore } from './types'
import type { OSAction, WindowCaptureAction } from '@yaar/shared'
import html2canvas from 'html2canvas'

// Import all slice creators
import {
  createWindowsSlice,
  createNotificationsSlice,
  createToastsSlice,
  createDialogsSlice,
  createConnectionSlice,
  createDebugSlice,
  createAgentsSlice,
  createUiSlice,
  createFeedbackSlice,
  createInteractionsSlice,
  createQueuedActionsSlice,
  createDrawingSlice,
} from './slices'

/**
 * Try capturing iframe content via the postMessage self-capture protocol.
 * Returns a base64 PNG data URL or null if the iframe doesn't respond.
 */
function tryIframeSelfCapture(iframe: HTMLIFrameElement, timeoutMs = 2000): Promise<string | null> {
  return new Promise((resolve) => {
    const requestId = `capture-${Date.now()}-${Math.random().toString(36).slice(2)}`

    const timer = setTimeout(() => {
      window.removeEventListener('message', handler)
      resolve(null)
    }, timeoutMs)

    function handler(e: MessageEvent) {
      if (
        e.data?.type === 'yaar:capture-response' &&
        e.data.requestId === requestId &&
        e.source === iframe.contentWindow
      ) {
        clearTimeout(timer)
        window.removeEventListener('message', handler)
        resolve(e.data.imageData ?? null)
      }
    }

    window.addEventListener('message', handler)
    iframe.contentWindow?.postMessage({ type: 'yaar:capture-request', requestId }, '*')
  })
}

/**
 * Capture a window element as a PNG image and push feedback.
 */
async function captureWindow(windowId: string, requestId: string) {
  try {
    const el = document.querySelector(`[data-window-id="${windowId}"]`) as HTMLElement | null
    if (!el) {
      useDesktopStore.getState().addRenderingFeedback({
        requestId,
        windowId,
        renderer: 'capture',
        success: false,
        error: `Window element not found in DOM`,
      })
      return
    }

    // If the window contains an iframe, try self-capture first
    const iframe = el.querySelector('iframe') as HTMLIFrameElement | null
    if (iframe?.contentWindow) {
      const iframeData = await tryIframeSelfCapture(iframe)
      if (iframeData) {
        const base64 = iframeData.replace(/^data:image\/png;base64,/, '')
        useDesktopStore.getState().addRenderingFeedback({
          requestId,
          windowId,
          renderer: 'capture',
          success: true,
          imageData: base64,
        })
        return
      }
    }

    // Fall back to html2canvas
    const canvas = await html2canvas(el, {
      useCORS: true,
      logging: false,
      scale: 1,
    })

    const dataUrl = canvas.toDataURL('image/png')
    // Strip the data:image/png;base64, prefix
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '')

    useDesktopStore.getState().addRenderingFeedback({
      requestId,
      windowId,
      renderer: 'capture',
      success: true,
      imageData: base64,
    })
  } catch (error) {
    useDesktopStore.getState().addRenderingFeedback({
      requestId,
      windowId,
      renderer: 'capture',
      success: false,
      error: error instanceof Error ? error.message : 'Capture failed',
    })
  }
}

export const useDesktopStore = create<DesktopStore>()(
  immer((...a) => ({
    // Combine all slices
    ...createWindowsSlice(...a),
    ...createNotificationsSlice(...a),
    ...createToastsSlice(...a),
    ...createDialogsSlice(...a),
    ...createConnectionSlice(...a),
    ...createDebugSlice(...a),
    ...createAgentsSlice(...a),
    ...createUiSlice(...a),
    ...createFeedbackSlice(...a),
    ...createInteractionsSlice(...a),
    ...createQueuedActionsSlice(...a),
    ...createDrawingSlice(...a),

    // Action router - routes OS actions to appropriate slice handlers
    applyAction: (action: OSAction) => {
      const store = useDesktopStore.getState()

      // Log to activity log
      store.addToActivityLog(action)

      // Route to appropriate slice handler based on action type prefix
      const actionType = action.type

      if (actionType === 'window.capture') {
        // Handle capture async (outside Immer)
        const { windowId, requestId } = action as WindowCaptureAction & { requestId?: string }
        if (requestId) {
          captureWindow(windowId, requestId)
        }
        return
      }

      if (actionType.startsWith('window.')) {
        store.handleWindowAction(action)
      } else if (actionType.startsWith('notification.')) {
        store.handleNotificationAction(action)
      } else if (actionType.startsWith('toast.')) {
        store.handleToastAction(action)
      } else if (actionType.startsWith('dialog.')) {
        store.handleDialogAction(action)
      }
    },

    applyActions: (actions: OSAction[]) => {
      const store = useDesktopStore.getState()
      for (const action of actions) {
        store.applyAction(action)
      }
    },

    resetDesktop: () => {
      const [set] = a
      set((state) => {
        state.windows = {}
        state.zOrder = []
        state.focusedWindowId = null
        state.notifications = {}
        state.toasts = {}
        state.dialogs = {}
        state.activeAgents = {}
        state.windowAgents = {}
        state.queuedActions = {}
        state.interactionLog = []
        state.pendingInteractions = []
        state.activityLog = []
        state.debugLog = []
        state.pendingFeedback = []
      })
    },
  }))
)

// Re-export selectors for backward compatibility
export {
  selectWindowsInOrder,
  selectVisibleWindows,
  selectToasts,
  selectNotifications,
  selectDialogs,
  selectActiveAgents,
  selectWindowAgents,
  selectWindowAgent,
  selectQueuedActionsCount,
} from './selectors'
