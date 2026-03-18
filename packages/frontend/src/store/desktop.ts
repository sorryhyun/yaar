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
  DesktopShortcut,
  DesktopCreateShortcutAction,
  DesktopRemoveShortcutAction,
  DesktopUpdateShortcutAction,
  DesktopUpdateSettingsAction,
} from '@yaar/shared';
import { resolveWindowKey } from './helpers';
import { DEFAULT_MONITOR_ID } from '@yaar/shared';
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
  createMessageStatusSlice,
} from './slices';

// Import pure mutation functions for batched action processing
import { applyWindowAction } from './slices/windowsSlice';
import { applyNotificationAction } from './slices/notificationsSlice';
import { applyToastAction } from './slices/toastsSlice';
import { applyDialogAction } from './slices/dialogsSlice';
import { applyUserPromptAction } from './slices/userPromptsSlice';

// Import iframe bridge (circular import — safe, only accessed at runtime)
import {
  captureWindow,
  initIframeMessageHandlers,
  initWindowsSdkHandler,
  initNotificationBroadcaster,
} from './iframe-bridge';

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
    ...createMessageStatusSlice(...a),

    // Desktop-level state
    appBadges: {} as Record<string, number>,
    appsVersion: 0,
    shortcuts: [] as DesktopShortcut[],
    setShortcuts: (shortcuts: DesktopShortcut[]) => {
      const [set] = a;
      set((state) => {
        state.shortcuts = shortcuts;
      });
    },
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
          const monitorId = actionMonitorId ?? state.activeMonitorId ?? DEFAULT_MONITOR_ID;
          const key = resolveWindowKey(state.windows, windowId, monitorId);
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
      } else if (actionType === 'desktop.updateSettings') {
        const { settings } = action as DesktopUpdateSettingsAction;
        store.applyServerSettings(settings);
      }
    },

    applyActions: (actions: OSAction[]) => {
      // Partition into sync (batchable) and async (must run outside Immer) actions
      const syncActions: OSAction[] = [];
      const asyncActions: OSAction[] = [];
      for (const action of actions) {
        if (action.type === 'window.capture' || action.type === 'desktop.updateSettings')
          asyncActions.push(action);
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
        // Preserve windows, zOrder, focusedWindowId, monitors, shortcuts, appBadges
        // Only clear agent/context/pending state
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
        state.attachedImages = [];
        state.cliHistory = {};
        state.cliStreaming = {};
        state.messageStatuses = {};
      });
    },

    clearDesktop: () => {
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
        state.messageStatuses = {};
        state.monitors = [{ id: DEFAULT_MONITOR_ID, label: 'Monitor 1', createdAt: Date.now() }];
        state.activeMonitorId = DEFAULT_MONITOR_ID;
      });
    },
  })),
);

// Initialize iframe bridges (must run after store creation)
initIframeMessageHandlers();
initWindowsSdkHandler();
initNotificationBroadcaster();
