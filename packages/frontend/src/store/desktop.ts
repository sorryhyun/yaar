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
import type { OSAction, WindowCaptureAction, AppProtocolRequest, AppProtocolResponse } from '@yaar/shared'
import { toWindowKey } from './helpers'
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
  createCliSlice,
  createMonitorSlice,
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

/**
 * Handle an App Protocol request by forwarding it to the target iframe via postMessage,
 * then collecting the response and pushing it as pending feedback.
 */
function handleAppProtocolRequest(requestId: string, windowId: string, request: AppProtocolRequest) {
  const state = useDesktopStore.getState()
  const monitorId = state.activeMonitorId ?? 'monitor-0'
  const key = state.windows[windowId] ? windowId : toWindowKey(monitorId, windowId)

  const el = document.querySelector(`[data-window-id="${key}"]`) as HTMLElement | null
  if (!el) {
    useDesktopStore.getState().addPendingAppProtocolResponse({
      requestId, windowId, response: { kind: request.kind, error: 'Window element not found' } as AppProtocolResponse
    })
    return
  }

  const iframe = el.querySelector('iframe') as HTMLIFrameElement | null
  if (!iframe?.contentWindow) {
    useDesktopStore.getState().addPendingAppProtocolResponse({
      requestId, windowId, response: { kind: request.kind, error: 'No iframe found in window' } as AppProtocolResponse
    })
    return
  }

  // Build postMessage based on request kind
  let msg: Record<string, unknown>
  if (request.kind === 'manifest') {
    msg = { type: 'yaar:app-manifest-request', requestId }
  } else if (request.kind === 'query') {
    msg = { type: 'yaar:app-query-request', requestId, stateKey: request.stateKey }
  } else {
    msg = { type: 'yaar:app-command-request', requestId, command: request.command, params: request.params }
  }

  // Listen for response with timeout
  const timeoutId = setTimeout(() => {
    window.removeEventListener('message', handler)
    useDesktopStore.getState().addPendingAppProtocolResponse({
      requestId, windowId, response: { kind: request.kind, error: 'Timeout waiting for app response' } as AppProtocolResponse
    })
  }, 5000)

  function handler(e: MessageEvent) {
    if (!e.data?.requestId || e.data.requestId !== requestId) return
    const type = e.data.type as string
    if (!type?.startsWith('yaar:app-')) return

    clearTimeout(timeoutId)
    window.removeEventListener('message', handler)

    let response: AppProtocolResponse
    if (type === 'yaar:app-manifest-response') {
      response = { kind: 'manifest', manifest: e.data.manifest, error: e.data.error }
    } else if (type === 'yaar:app-query-response') {
      response = { kind: 'query', data: e.data.data, error: e.data.error }
    } else if (type === 'yaar:app-command-response') {
      response = { kind: 'command', result: e.data.result, error: e.data.error }
    } else {
      return
    }

    useDesktopStore.getState().addPendingAppProtocolResponse({ requestId, windowId, response })
  }

  window.addEventListener('message', handler)
  iframe.contentWindow.postMessage(msg, '*')
}

export { handleAppProtocolRequest }

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
    ...createCliSlice(...a),
    ...createMonitorSlice(...a),

    // Desktop-level state
    appsVersion: 0,
    bumpAppsVersion: () => {
      const [set] = a
      set((state) => { state.appsVersion += 1 })
    },

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
          // Resolve scoped key: server sends raw windowId, store uses monitorId-scoped keys
          const state = useDesktopStore.getState()
          const actionMonitorId = (action as { monitorId?: string }).monitorId
          const monitorId = actionMonitorId ?? state.activeMonitorId ?? 'monitor-0'
          const key = state.windows[windowId] ? windowId : toWindowKey(monitorId, windowId)
          captureWindow(key, requestId)
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
      } else if (actionType === 'desktop.refreshApps') {
        store.bumpAppsVersion()
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
        state.pendingInteractions = []
        state.activityLog = []
        state.debugLog = []
        state.pendingFeedback = []
        state.pendingAppProtocolResponses = []
        state.selectedWindowIds = []
        state.appsVersion = 0
        state.cliMode = false
        state.cliHistory = {}
        state.cliStreaming = {}
        state.monitors = [{ id: 'monitor-0', label: 'Monitor 1', createdAt: Date.now() }]
        state.activeMonitorId = 'monitor-0'
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
