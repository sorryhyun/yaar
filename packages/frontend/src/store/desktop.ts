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
  WindowAction,
  WindowCaptureAction,
  DesktopShortcut,
  DesktopCreateShortcutAction,
  DesktopRemoveShortcutAction,
  DesktopUpdateShortcutAction,
  DesktopUpdateSettingsAction,
  WindowCreateAction,
  ActiveAgentSnapshot,
  UserClipboardAction,
} from '@yaar/shared';
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
  createOutboxSlice,
} from './slices';

// Import pure mutation functions for batched action processing
import { applyWindowAction } from './slices/windowsSlice';
import { toWindowKey } from './helpers';
import { notifyIframeClose } from './iframe-bridge';
import { applyNotificationAction } from './slices/notificationsSlice';
import { applyToastAction } from './slices/toastsSlice';
import { applyDialogAction } from './slices/dialogsSlice';
import { applyUserPromptAction } from './slices/userPromptsSlice';
import { handleClipboardAction } from '@/lib/clipboard';

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
    ...createOutboxSlice(...a),

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
          // Server stamps scoped handle on windowId — use directly
          captureWindow(windowId, requestId);
        }
        return;
      }

      // The clipboard is reached through `navigator`, not through store state — same
      // shape as `window.capture`: do the async work, answer the socket, hold nothing.
      if (actionType.startsWith('user.clipboard.')) {
        handleClipboardAction(action as UserClipboardAction);
        return;
      }

      if (actionType.startsWith('window.')) {
        store.handleWindowAction(action as WindowAction);
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
      } else {
        console.warn(`[applyAction] Unhandled action type: ${actionType}`);
      }
    },

    applyActions: (actions: OSAction[]) => {
      // Partition into sync (batchable) and async (must run outside Immer) actions
      const syncActions: OSAction[] = [];
      const asyncActions: OSAction[] = [];
      for (const action of actions) {
        if (
          action.type === 'window.capture' ||
          action.type === 'desktop.updateSettings' ||
          action.type.startsWith('user.clipboard.')
        )
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
            if (t.startsWith('window.'))
              applyWindowAction(state as DesktopStore, action as WindowAction);
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
            } else {
              console.warn(`[applyActions] Unhandled action type: ${t}`);
            }
          }
        });
      }

      // Handle async actions individually (e.g. window.capture needs DOM access)
      for (const action of asyncActions) {
        useDesktopStore.getState().applyAction(action);
      }
    },

    /**
     * Converge on the server's answer to "what is here" — including what is *not*.
     *
     * The reconnect path used to re-send `window.create` for every live window and let the
     * client merge them in. Merging can only ever *add*, so everything that happened during
     * the gap in the other direction was invisible: a window an agent closed while the
     * socket was down stayed on screen, clickable, wired to a window the server had already
     * forgotten; a spinner for an agent that finished mid-outage ran until the tab was
     * reloaded; a dialog that expired unanswered still offered its buttons.
     *
     * So the snapshot is authoritative and this *replaces*. Every surface it covers —
     * windows, notifications, dialogs, prompts, running agents — is rebuilt from it, and
     * anything the server did not name is gone. The surfaces are re-materialized by running
     * their creating actions through the ordinary reducer, so a restored window is built by
     * exactly the same code as a live one and cannot drift from it.
     *
     * Message status is the one thing deliberately not replaced: the client's outbox knows
     * what it sent, and resending rebuilds status from the acks that come back. See
     * `slices/outboxSlice.ts`.
     */
    applySnapshot: (actions: OSAction[], agents: ActiveAgentSnapshot[]) => {
      const [set] = a;

      // The windows the server still has. A snapshot always names windows by their scoped
      // handle ("0/notes"); the fallback mirrors applyWindowAction for anything that isn't.
      const liveWindowKeys = new Set(
        actions
          .filter((action): action is WindowCreateAction => action.type === 'window.create')
          .map((action) => {
            const rawId = action.windowId;
            if (rawId.includes('/')) return rawId;
            const monitorId =
              (action as { monitorId?: string }).monitorId ??
              useDesktopStore.getState().activeMonitorId ??
              DEFAULT_MONITOR_ID;
            return toWindowKey(monitorId, rawId);
          }),
      );

      // Drop what the server does not have, before rebuilding what it does.
      const stale = Object.keys(useDesktopStore.getState().windows).filter(
        (key) => !liveWindowKeys.has(key),
      );
      for (const key of stale) notifyIframeClose(key);

      set((state) => {
        for (const key of stale) {
          delete state.windows[key];
          delete state.queuedActions[key];
        }
        state.zOrder = state.zOrder.filter((id) => !stale.includes(id));
        if (state.focusedWindowId && stale.includes(state.focusedWindowId)) {
          state.focusedWindowId = state.zOrder[state.zOrder.length - 1] ?? null;
        }

        // Surfaces the snapshot is authoritative for: emptied here, refilled below from the
        // snapshot's own actions. A dialog answered during the gap does not come back.
        state.notifications = {};
        state.dialogs = {};
        state.userPrompts = {};

        // Who is actually still working. This is the spinner that used to run forever.
        state.activeAgents = {};
        for (const agent of agents) {
          state.activeAgents[agent.agentId] = {
            id: agent.agentId,
            status: agent.status,
            startedAt: Date.now(),
            subagentCount: 0,
          };
        }
      });

      useDesktopStore.getState().applyActions(actions);
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
        state.pendingAppInteractions = [];
        state.pendingAppEvents = [];
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
        state.pendingAppInteractions = [];
        state.pendingAppEvents = [];
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
