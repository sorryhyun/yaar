/**
 * The Desktop Store - where AI decisions become UI reality.
 *
 * When the AI emits an action like:
 *   {"type": "window.create", "windowId": "w1", "title": "Hello", ...}
 *
 * This store processes it and updates the state, causing React to render
 * the new window. The AI literally controls what appears on screen.
 */
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { DesktopStore } from './types';
import type {
  OSAction,
  WindowCaptureAction,
  AppProtocolRequest,
  AppProtocolResponse,
  DesktopShortcut,
  DesktopCreateShortcutAction,
  DesktopRemoveShortcutAction,
  DesktopUpdateShortcutAction,
} from '@yaar/shared';
import { toWindowKey } from './helpers';
import html2canvas from 'html2canvas';

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
  createSettingsSlice,
  createFeedbackSlice,
  createInteractionsSlice,
  createQueuedActionsSlice,
  createDrawingSlice,
  createImageAttachSlice,
  createCliSlice,
  createMonitorSlice,
  createUserPromptsSlice,
} from './slices';

// Import pure mutation functions for batched action processing
import { applyWindowAction } from './slices/windowsSlice';
import { applyNotificationAction } from './slices/notificationsSlice';
import { applyToastAction } from './slices/toastsSlice';
import { applyDialogAction } from './slices/dialogsSlice';
import { applyUserPromptAction } from './slices/userPromptsSlice';

/**
 * Try capturing iframe content via the postMessage self-capture protocol.
 * Returns a base64 PNG data URL or null if the iframe doesn't respond.
 */
export function tryIframeSelfCapture(
  iframe: HTMLIFrameElement,
  timeoutMs = 2000,
): Promise<string | null> {
  return new Promise((resolve) => {
    const requestId = `capture-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const timer = setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve(null);
    }, timeoutMs);

    function handler(e: MessageEvent) {
      if (
        e.data?.type === 'yaar:capture-response' &&
        e.data.requestId === requestId &&
        e.source === iframe.contentWindow
      ) {
        clearTimeout(timer);
        window.removeEventListener('message', handler);
        resolve(e.data.imageData ?? null);
      }
    }

    window.addEventListener('message', handler);
    iframe.contentWindow?.postMessage({ type: 'yaar:capture-request', requestId }, '*');
  });
}

/**
 * Capture a window element as a PNG image and push feedback.
 *
 * Three-tier capture for iframe windows:
 *   1. Iframe self-capture via postMessage (canvas/svg inside the iframe)
 *   2. html2canvas on the iframe's content document (same-origin only)
 *   3. html2canvas on the window frame element (non-iframe or cross-origin fallback)
 */
async function captureWindow(windowId: string, requestId: string) {
  try {
    const el = document.querySelector(`[data-window-id="${windowId}"]`) as HTMLElement | null;
    if (!el) {
      useDesktopStore.getState().addRenderingFeedback({
        requestId,
        windowId,
        renderer: 'capture',
        success: false,
        error: `Window element not found in DOM`,
      });
      return;
    }

    // If the window contains an iframe, try capture strategies in order
    const iframe = el.querySelector('iframe') as HTMLIFrameElement | null;
    if (iframe?.contentWindow) {
      // Tier 1: iframe self-capture (captures canvas/svg elements inside)
      const iframeData = await tryIframeSelfCapture(iframe);
      if (iframeData) {
        const base64 = iframeData.replace(/^data:image\/[^;]+;base64,/, '');
        useDesktopStore.getState().addRenderingFeedback({
          requestId,
          windowId,
          renderer: 'capture',
          success: true,
          imageData: base64,
        });
        return;
      }

      // Tier 2: html2canvas on iframe's content document (same-origin only)
      try {
        const doc = iframe.contentDocument;
        if (doc?.documentElement) {
          const canvas = await html2canvas(doc.documentElement, {
            useCORS: true,
            logging: false,
            scale: 1,
            width: iframe.clientWidth || undefined,
            height: iframe.clientHeight || undefined,
          });
          const dataUrl = canvas.toDataURL('image/webp', 0.9);
          const base64 = dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
          useDesktopStore.getState().addRenderingFeedback({
            requestId,
            windowId,
            renderer: 'capture',
            success: true,
            imageData: base64,
          });
          return;
        }
      } catch {
        // Cross-origin or html2canvas failure — fall through to Tier 3
      }
    }

    // Tier 3: html2canvas on the window frame element
    const canvas = await html2canvas(el, {
      useCORS: true,
      logging: false,
      scale: 1,
    });

    const dataUrl = canvas.toDataURL('image/webp', 0.9);
    const base64 = dataUrl.replace(/^data:image\/[^;]+;base64,/, '');

    useDesktopStore.getState().addRenderingFeedback({
      requestId,
      windowId,
      renderer: 'capture',
      success: true,
      imageData: base64,
    });
  } catch (error) {
    useDesktopStore.getState().addRenderingFeedback({
      requestId,
      windowId,
      renderer: 'capture',
      success: false,
      error: error instanceof Error ? error.message : 'Capture failed',
    });
  }
}

/**
 * Handle an App Protocol request by forwarding it to the target iframe via postMessage,
 * then collecting the response and pushing it as pending feedback.
 */
function handleAppProtocolRequest(
  requestId: string,
  windowId: string,
  request: AppProtocolRequest,
) {
  const state = useDesktopStore.getState();
  const monitorId = state.activeMonitorId ?? 'monitor-0';
  const key = state.windows[windowId] ? windowId : toWindowKey(monitorId, windowId);

  const el = document.querySelector(`[data-window-id="${key}"]`) as HTMLElement | null;
  if (!el) {
    useDesktopStore.getState().addPendingAppProtocolResponse({
      requestId,
      windowId,
      response: { kind: request.kind, error: 'Window element not found' } as AppProtocolResponse,
    });
    return;
  }

  const iframe = el.querySelector('iframe') as HTMLIFrameElement | null;
  if (!iframe?.contentWindow) {
    useDesktopStore.getState().addPendingAppProtocolResponse({
      requestId,
      windowId,
      response: { kind: request.kind, error: 'No iframe found in window' } as AppProtocolResponse,
    });
    return;
  }

  // Build postMessage based on request kind
  let msg: Record<string, unknown>;
  if (request.kind === 'manifest') {
    msg = { type: 'yaar:app-manifest-request', requestId };
  } else if (request.kind === 'query') {
    msg = { type: 'yaar:app-query-request', requestId, stateKey: request.stateKey };
  } else {
    msg = {
      type: 'yaar:app-command-request',
      requestId,
      command: request.command,
      params: request.params,
    };
  }

  // Listen for response with timeout
  const timeoutId = setTimeout(() => {
    window.removeEventListener('message', handler);
    useDesktopStore.getState().addPendingAppProtocolResponse({
      requestId,
      windowId,
      response: {
        kind: request.kind,
        error: 'Timeout waiting for app response',
      } as AppProtocolResponse,
    });
  }, 5000);

  function handler(e: MessageEvent) {
    if (!e.data?.requestId || e.data.requestId !== requestId) return;
    const type = e.data.type as string;
    if (!type?.startsWith('yaar:app-')) return;

    // Validate that the response came from the expected iframe
    if (e.source !== iframe!.contentWindow) {
      console.warn(
        `[AppProtocol] Ignoring response for ${requestId}: source mismatch (possible spoofing)`,
      );
      return;
    }

    clearTimeout(timeoutId);
    window.removeEventListener('message', handler);

    let response: AppProtocolResponse;
    if (type === 'yaar:app-manifest-response') {
      if (e.data.manifest == null && e.data.error == null) {
        console.warn(`[AppProtocol] Manifest response missing both manifest and error fields`);
      }
      response = { kind: 'manifest', manifest: e.data.manifest, error: e.data.error };
    } else if (type === 'yaar:app-query-response') {
      if (e.data.data === undefined && e.data.error == null) {
        console.warn(`[AppProtocol] Query response missing both data and error fields`);
      }
      response = { kind: 'query', data: e.data.data, error: e.data.error };
    } else if (type === 'yaar:app-command-response') {
      if (e.data.result === undefined && e.data.error == null) {
        console.warn(`[AppProtocol] Command response missing both result and error fields`);
      }
      response = { kind: 'command', result: e.data.result, error: e.data.error };
    } else {
      return;
    }

    useDesktopStore.getState().addPendingAppProtocolResponse({ requestId, windowId, response });
  }

  window.addEventListener('message', handler);
  iframe.contentWindow.postMessage(msg, '*');
}

export { handleAppProtocolRequest };

/**
 * Listen for `yaar:app-ready` postMessages from iframes that register with the App Protocol.
 * Resolves the iframe source to a windowId and queues an APP_PROTOCOL_READY event.
 *
 * Also listens for `yaar:app-interaction` postMessages — app-initiated events that get
 * routed to the window's agent via WINDOW_MESSAGE.
 */
function initAppProtocolListeners() {
  window.addEventListener('message', (e: MessageEvent) => {
    if (!e.data?.type) return;

    if (e.data.type === 'yaar:app-ready') {
      // Find the iframe whose contentWindow matches the message source
      const iframes = document.querySelectorAll<HTMLIFrameElement>('[data-window-id] iframe');
      for (const iframe of iframes) {
        if (iframe.contentWindow === e.source) {
          const windowEl = iframe.closest<HTMLElement>('[data-window-id]');
          const windowId = windowEl?.dataset.windowId;
          if (windowId) {
            useDesktopStore.getState().addAppProtocolReady(windowId);
          }
          break;
        }
      }
      return;
    }

    if (e.data.type === 'yaar:app-interaction') {
      const content = e.data.content;
      if (typeof content !== 'string' || !content) return;

      // Find the iframe whose contentWindow matches the message source
      const iframes = document.querySelectorAll<HTMLIFrameElement>('[data-window-id] iframe');
      for (const iframe of iframes) {
        if (iframe.contentWindow === e.source) {
          const windowEl = iframe.closest<HTMLElement>('[data-window-id]');
          const windowId = windowEl?.dataset.windowId;
          if (windowId) {
            useDesktopStore.getState().addPendingAppInteraction({ windowId, content });
          }
          break;
        }
      }
      return;
    }

    if (e.data.type === 'yaar:click') {
      useDesktopStore.getState().hideContextMenu();
      return;
    }

    if (e.data.type === 'yaar:contextmenu') {
      // Find the iframe whose contentWindow matches the message source
      const iframes = document.querySelectorAll<HTMLIFrameElement>('[data-window-id] iframe');
      for (const iframe of iframes) {
        if (iframe.contentWindow === e.source) {
          const windowEl = iframe.closest<HTMLElement>('[data-window-id]');
          const windowId = windowEl?.dataset.windowId;
          if (windowId) {
            // Convert iframe-local coordinates to parent viewport coordinates
            const rect = iframe.getBoundingClientRect();
            const x = rect.left + (e.data.clientX ?? 0);
            const y = rect.top + (e.data.clientY ?? 0);
            useDesktopStore.getState().showContextMenu(x, y, windowId);
          }
          break;
        }
      }
      return;
    }

    if (e.data.type === 'yaar:drag-start') {
      const text = String(e.data.text ?? '').trim();
      if (!text) return;
      const iframes = document.querySelectorAll<HTMLIFrameElement>('[data-window-id] iframe');
      for (const iframe of iframes) {
        if (iframe.contentWindow === e.source) {
          const windowEl = iframe.closest<HTMLElement>('[data-window-id]');
          const windowId = windowEl?.dataset.windowId;
          if (windowId) {
            _iframeDragSource = { windowId, text };
          }
          break;
        }
      }
    }
  });
}

/** Tracks in-flight text drag from an iframe. */
let _iframeDragSource: { windowId: string; text: string } | null = null;

/** Check if an iframe text drag is in progress. */
export function getIframeDragSource() {
  return _iframeDragSource;
}

/** Consume (read + clear) the iframe drag source. */
export function consumeIframeDragSource() {
  const src = _iframeDragSource;
  _iframeDragSource = null;
  return src;
}

// Initialize the listeners immediately
initAppProtocolListeners();

export const useDesktopStore = create<DesktopStore>()(
  immer((...a) => ({
    // Combine all slices
    ...createWindowsSlice(...a),
    ...createNotificationsSlice(...a),
    ...createToastsSlice(...a),
    ...createDialogsSlice(...a),
    ...createUserPromptsSlice(...a),
    ...createConnectionSlice(...a),
    ...createDebugSlice(...a),
    ...createAgentsSlice(...a),
    ...createUiSlice(...a),
    ...createSettingsSlice(...a),
    ...createFeedbackSlice(...a),
    ...createInteractionsSlice(...a),
    ...createQueuedActionsSlice(...a),
    ...createDrawingSlice(...a),
    ...createImageAttachSlice(...a),
    ...createCliSlice(...a),
    ...createMonitorSlice(...a),

    // Desktop-level state
    appBadges: {} as Record<string, number>,
    appsVersion: 0,
    shortcuts: [] as DesktopShortcut[],
    bumpAppsVersion: () => {
      const [set] = a;
      set((state) => {
        state.appsVersion += 1;
      });
    },

    // Action router - routes OS actions to appropriate slice handlers
    applyAction: (action: OSAction) => {
      const store = useDesktopStore.getState();

      // Log to activity log
      store.addToActivityLog(action);

      // Route to appropriate slice handler based on action type prefix
      const actionType = action.type;

      if (actionType === 'window.capture') {
        // Handle capture async (outside Immer)
        const { windowId, requestId } = action as WindowCaptureAction & { requestId?: string };
        if (requestId) {
          // Resolve scoped key: server sends raw windowId, store uses monitorId-scoped keys
          const state = useDesktopStore.getState();
          const actionMonitorId = (action as { monitorId?: string }).monitorId;
          const monitorId = actionMonitorId ?? state.activeMonitorId ?? 'monitor-0';
          const key = state.windows[windowId] ? windowId : toWindowKey(monitorId, windowId);
          captureWindow(key, requestId);
        }
        return;
      }

      if (actionType.startsWith('window.')) {
        store.handleWindowAction(action);
      } else if (actionType.startsWith('notification.')) {
        store.handleNotificationAction(action);
      } else if (actionType.startsWith('toast.')) {
        store.handleToastAction(action);
      } else if (actionType.startsWith('dialog.')) {
        store.handleDialogAction(action);
      } else if (actionType.startsWith('user.prompt.')) {
        store.handleUserPromptAction(action);
      } else if (actionType === 'app.badge') {
        const { appId, count } = action as import('@yaar/shared').AppBadgeAction;
        const [set] = a;
        set((state) => {
          if (count > 0) {
            state.appBadges[appId] = count;
          } else {
            delete state.appBadges[appId];
          }
        });
      } else if (actionType === 'desktop.refreshApps') {
        store.bumpAppsVersion();
      } else if (actionType === 'desktop.createShortcut') {
        const { shortcut } = action as DesktopCreateShortcutAction;
        const [set] = a;
        set((state) => {
          state.shortcuts.push(shortcut);
        });
      } else if (actionType === 'desktop.removeShortcut') {
        const { shortcutId } = action as DesktopRemoveShortcutAction;
        const [set] = a;
        set((state) => {
          state.shortcuts = state.shortcuts.filter((s) => s.id !== shortcutId);
        });
      } else if (actionType === 'desktop.updateShortcut') {
        const { shortcutId, updates } = action as DesktopUpdateShortcutAction;
        const [set] = a;
        set((state) => {
          const sc = state.shortcuts.find((s) => s.id === shortcutId);
          if (sc) Object.assign(sc, updates);
        });
      }
    },

    applyActions: (actions: OSAction[]) => {
      // Partition into sync (batchable) and async (must run outside Immer) actions
      const syncActions: OSAction[] = [];
      const asyncActions: OSAction[] = [];
      for (const action of actions) {
        if (action.type === 'window.capture') asyncActions.push(action);
        else syncActions.push(action);
      }

      // Batch all sync actions into a single Immer transaction → 1 re-render
      if (syncActions.length > 0) {
        const [set] = a;
        set((state) => {
          for (const action of syncActions) {
            state.activityLog.push(action);
            const t = action.type;
            if (t.startsWith('window.')) applyWindowAction(state as DesktopStore, action);
            else if (t.startsWith('notification.')) applyNotificationAction(state, action);
            else if (t.startsWith('toast.')) applyToastAction(state, action);
            else if (t.startsWith('dialog.')) applyDialogAction(state, action);
            else if (t.startsWith('user.prompt.')) applyUserPromptAction(state, action);
            else if (t === 'app.badge') {
              const { appId, count } = action as import('@yaar/shared').AppBadgeAction;
              if (count > 0) state.appBadges[appId] = count;
              else delete state.appBadges[appId];
            } else if (t === 'desktop.refreshApps') state.appsVersion += 1;
            else if (t === 'desktop.createShortcut') {
              state.shortcuts.push((action as DesktopCreateShortcutAction).shortcut);
            } else if (t === 'desktop.removeShortcut') {
              const sid = (action as DesktopRemoveShortcutAction).shortcutId;
              state.shortcuts = state.shortcuts.filter((s) => s.id !== sid);
            } else if (t === 'desktop.updateShortcut') {
              const { shortcutId, updates } = action as DesktopUpdateShortcutAction;
              const sc = state.shortcuts.find((s) => s.id === shortcutId);
              if (sc) Object.assign(sc, updates);
            }
          }
        });
      }

      // Handle async actions individually (e.g. window.capture needs DOM access)
      for (const action of asyncActions) {
        useDesktopStore.getState().applyAction(action);
      }
    },

    resetDesktop: () => {
      const [set] = a;
      set((state) => {
        state.windows = {};
        state.zOrder = [];
        state.focusedWindowId = null;
        state.notifications = {};
        state.toasts = {};
        state.dialogs = {};
        state.userPrompts = {};
        state.activeAgents = {};
        state.windowAgents = {};
        state.queuedActions = {};
        state.pendingInteractions = [];
        state.pendingGestureMessages = [];
        state.activityLog = [];
        state.debugLog = [];
        state.pendingFeedback = [];
        state.pendingAppProtocolResponses = [];
        state.pendingAppProtocolReady = [];
        state.pendingAppInteractions = [];
        state.selectedWindowIds = [];
        state.appBadges = {};
        state.appsVersion = 0;
        state.shortcuts = [];
        state.attachedImages = [];
        state.cliMode = false;
        state.cliHistory = {};
        state.cliStreaming = {};
        state.monitors = [{ id: 'monitor-0', label: 'Monitor 1', createdAt: Date.now() }];
        state.activeMonitorId = 'monitor-0';
      });
    },
  })),
);

// Re-export selectors for backward compatibility
export {
  selectWindowsInOrder,
  selectVisibleWindows,
  selectToasts,
  selectNotifications,
  selectDialogs,
  selectUserPrompts,
  selectActiveAgents,
  selectWindowAgents,
  selectWindowAgent,
  selectQueuedActionsCount,
} from './selectors';
