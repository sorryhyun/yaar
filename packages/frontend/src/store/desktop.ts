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
  AppBadgeAction,
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
import { toWindowKey, monitorOfWindowId } from './helpers';
import { notifyIframeClose } from './iframe-bridge';
import { applyNotificationAction } from './slices/notificationsSlice';
import { applyToastAction } from './slices/toastsSlice';
import { applyDialogAction } from './slices/dialogsSlice';
import { applyUserPromptAction } from './slices/userPromptsSlice';
import { logActivity, trimActivityLog } from './slices/debugSlice';
import { handleClipboardAction } from './clipboard';

// Import iframe bridge (circular import — safe, only accessed at runtime)
import {
  captureWindow,
  initIframeMessageHandlers,
  initWindowsSdkHandler,
  initNotificationBroadcaster,
} from './iframe-bridge';

/**
 * agentId → the monitor it is working for, for the agents where that can be told at all.
 *
 * `ActiveAgent` carries no monitorId: it is minted from AGENT_THINKING, which names only
 * the agent. Two other things in the store do know. Every CLI entry an agent produced is
 * filed under a monitor, and a window agent is bound to a window, which is bound to a
 * monitor — so the transcript and `windowAgents` are the witnesses.
 *
 * An agent whose witnesses disagree is recorded as `undefined` (unattributable) rather
 * than last-writer-wins, so a scoped reset leaves it running instead of clearing an agent
 * that may belong to another monitor.
 */
function mapAgentsToMonitors(state: DesktopStore): Map<string, string | undefined> {
  const placed = new Map<string, string | undefined>();
  const note = (agentId: string | undefined, monitorId: string | undefined) => {
    if (!agentId || !monitorId) return;
    if (placed.has(agentId) && placed.get(agentId) !== monitorId) placed.set(agentId, undefined);
    else placed.set(agentId, monitorId);
  };

  for (const entry of Object.values(state.cliStreaming)) note(entry.agentId, entry.monitorId);
  for (const [monitorId, entries] of Object.entries(state.cliHistory)) {
    for (const entry of entries) note(entry.agentId, entry.monitorId || monitorId);
  }
  // Keyed by agentId — the window is in the value, not the key (see `registerWindowAgent`).
  for (const agent of Object.values(state.windowAgents)) {
    note(agent.agentId, monitorOfWindowId(state.windows, agent.windowId));
  }
  return placed;
}

/**
 * The actions that reach outside the store — the DOM, the clipboard, the settings
 * endpoint — and each finish with a `set()` of their own. Running one inside an Immer
 * recipe is a bug, so this hands back the work rather than doing it, and returns `null`
 * for everything that belongs in `applySyncAction` instead.
 *
 * Being both the predicate and the work is the point: there is no second list of type
 * strings to keep in step with these branches.
 */
function asyncActionRunner(action: OSAction): (() => void) | null {
  const t = action.type;

  if (t === 'window.capture') {
    // Needs the live DOM. Server stamps a scoped handle on windowId — use it directly.
    const { windowId, requestId } = action as WindowCaptureAction & { requestId?: string };
    if (!requestId) return () => {};
    return () => captureWindow(windowId, requestId);
  }

  // The clipboard is reached through `navigator`, not through store state — same shape
  // as `window.capture`: do the async work, answer the socket, hold nothing.
  if (t.startsWith('user.clipboard.')) {
    return () => handleClipboardAction(action as UserClipboardAction);
  }

  // `applyServerSettings` is a `set()` in its own right, so it cannot run inside one.
  if (t === 'desktop.updateSettings') {
    const { settings } = action as DesktopUpdateSettingsAction;
    return () => useDesktopStore.getState().applyServerSettings(settings);
  }

  return null;
}

/**
 * Everything else: a pure mutation of the Immer draft, routed by type prefix.
 *
 * This is the only routing table. It was two — one per entry point, sixty lines apart,
 * every action type implemented twice — and they had already drifted: `desktop.refreshApps`
 * was a slice action on one side and an inline `+= 1` on the other. Neither prefix routing
 * nor the drift is checkable by the compiler, so the one thing worth not duplicating is
 * the table itself.
 */
function applySyncAction(state: DesktopStore, action: OSAction): void {
  const t = action.type;

  if (t.startsWith('window.')) applyWindowAction(state, action as WindowAction);
  else if (t.startsWith('notification.')) applyNotificationAction(state, action);
  else if (t.startsWith('toast.')) applyToastAction(state, action);
  else if (t.startsWith('dialog.')) applyDialogAction(state, action);
  else if (t.startsWith('user.prompt.')) applyUserPromptAction(state, action);
  else if (t === 'app.badge') {
    const { appId, count } = action as AppBadgeAction;
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
    console.warn(`[applyAction] Unhandled action type: ${t}`);
  }
}

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
    appKeybindings: {} as Record<string, string[]>,
    shortcuts: [] as DesktopShortcut[],
    setShortcuts: (shortcuts: DesktopShortcut[]) => {
      const [set] = a;
      set((state) => {
        state.shortcuts = shortcuts;
      });
    },
    setAppKeybindings: (keybindings: Record<string, string[]>) => {
      const [set] = a;
      set((state) => {
        state.appKeybindings = keybindings;
      });
    },
    bumpAppsVersion: () => {
      const [set] = a;
      set((state) => {
        state.appsVersion += 1;
      });
    },

    // Action router — one table, two entry points. `applyAction` is one action, straight
    // from a UI gesture; `applyActions` is a server batch that must land in a single
    // Immer transaction so a fifty-action turn is one re-render, not fifty.
    applyAction: (action: OSAction) => {
      const [set] = a;
      const runAsync = asyncActionRunner(action);
      set((state) => {
        const draft = state as DesktopStore;
        logActivity(draft, action);
        trimActivityLog(draft);
        if (!runAsync) applySyncAction(draft, action);
      });
      runAsync?.();
    },

    applyActions: (actions: OSAction[]) => {
      if (actions.length === 0) return;
      const [set] = a;

      // Partition *without running*: the async half reaches the DOM, the clipboard and
      // the settings endpoint, and has to see the state the sync half leaves behind — so
      // its work is held as a thunk until the recipe below has closed. The predicate and
      // the work are the same function, which is what stops this partition drifting from
      // the branches it has to match; it used to be a list of three type strings sixty
      // lines away from them, and an action that grew its own `set()` without being added
      // here would have been run inside an Immer recipe with nothing to catch it.
      const deferred: Array<() => void> = [];
      const syncActions: OSAction[] = [];
      for (const action of actions) {
        const runAsync = asyncActionRunner(action);
        if (runAsync) deferred.push(runAsync);
        else syncActions.push(action);
      }

      set((state) => {
        const draft = state as DesktopStore;
        for (const action of actions) logActivity(draft, action);
        for (const action of syncActions) applySyncAction(draft, action);
        trimActivityLog(draft);
      });

      for (const run of deferred) run();
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

      // A snapshot always names windows by their scoped handle ("0/notes"); the fallback
      // mirrors applyWindowAction for anything that isn't.
      const snapshotKey = (action: WindowCreateAction): string => {
        const rawId = action.windowId;
        if (rawId.includes('/')) return rawId;
        const monitorId =
          (action as { monitorId?: string }).monitorId ??
          useDesktopStore.getState().activeMonitorId ??
          DEFAULT_MONITOR_ID;
        return toWindowKey(monitorId, rawId);
      };

      const held = useDesktopStore.getState().windows;

      /**
       * The snapshot's actions, with the iframe token of every window we are *already
       * showing* left as it is.
       *
       * The server re-mints a token for every iframe window it reports
       * (`refreshRestoredWindowActions`), because a snapshot also answers a client whose
       * tokens were minted by a process that is gone. But a token rides in the iframe's
       * `src` (`IframeRenderer`), so writing a new one navigates the frame — and a resync
       * is not only a reconnect: `useClientPresence` fires one every time the tab comes
       * back from being hidden. On a phone that is every app switch, and it was reloading
       * every open app, which is how devtools kept coming back with no project open and
       * its agent re-cloned work that was already there.
       *
       * Keeping ours is safe because a re-mint does not revoke its predecessor
       * (`http/iframe-tokens.ts`) — our token is still live for as long as the process
       * that minted it is. The one case where it is *not* is an attach that is not a
       * rejoin of the same incarnation, and that case is already owned, in full and
       * independently of this path, by `refreshStaleIframeTokens`.
       */
      const reconciled = actions.map((action) => {
        if (action.type !== 'window.create') return action;
        const create = action as WindowCreateAction;
        const token = held[snapshotKey(create)]?.iframeToken;
        if (!token || !create.iframeToken || token === create.iframeToken) return action;
        return { ...create, iframeToken: token };
      });

      // The windows the server still has.
      const liveWindowKeys = new Set(
        reconciled
          .filter((action): action is WindowCreateAction => action.type === 'window.create')
          .map(snapshotKey),
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
            // The snapshot says an agent is busy, not since when — a reconnect cannot
            // recover the phase's real start, so the timer restarts here rather than
            // claiming a duration it does not know.
            statusSince: Date.now(),
            subagentCount: 0,
            // Sent, not parsed: the id is the turn's role when there is one, but can be an
            // instanceId with no prefix to read a tier off. The fallback is
            // `agentKindFromRole`'s own default, for an older server that sends no kind.
            kind: agent.kind ?? 'monitor',
            ...(agent.monitorId ? { monitorId: agent.monitorId } : {}),
          };
        }
      });

      useDesktopStore.getState().applyActions(reconciled);
    },

    /**
     * Forget the conversation, keep the desktop.
     *
     * With a `monitorId` this is **scoped**: only state that carries that monitor's
     * identity is cleared, because the reset was issued from that desktop and means that
     * desktop. Resetting while looking at monitor 2 used to wipe monitor 1's transcript,
     * its spinners, and every monitor's queued outbound work — a session-wide clear
     * dressed up as a per-desktop button.
     *
     * Two rules make the scoped branch safe:
     *
     *  - **Attribute, then clear.** A field is only cleared when its own monitor can be
     *    established — from a scoped window key, a `monitorId` the model carries, or the
     *    agent→monitor map built below. Anything unattributable is *left*: a stale
     *    spinner or an extra queued interaction is recoverable, another monitor's wiped
     *    transcript is not.
     *  - **The `pending*` arrays are filtered, not dropped.** They are outbound drain
     *    queues, not display state — every item in them is work this client owes the
     *    server. Emptying them because a different monitor was reset loses that work
     *    silently: an app protocol response never answered, an interaction the agent
     *    never hears about.
     *
     * Without a `monitorId` it is the original session-wide clear, unchanged.
     *
     * Both branches preserve windows, zOrder, focusedWindowId, monitors, shortcuts and
     * appBadges — a reset clears context, not the screen.
     */
    resetDesktop: (monitorId?: string) => {
      const [set, get] = a;

      if (monitorId) {
        // Read the agent→monitor evidence before anything is cleared: the CLI history is
        // half of that evidence and is about to be emptied for this monitor.
        const agentMonitors = mapAgentsToMonitors(get());

        // The cli slice already owns "clear one monitor's transcript", with exactly these
        // semantics. A second implementation here is a second thing to keep correct.
        get().clearCliHistory(monitorId);

        set((state) => {
          const onThisMonitor = (windowId: string) =>
            monitorOfWindowId(state.windows, windowId) === monitorId;

          // Surfaces that name their monitor outright.
          for (const [id, prompt] of Object.entries(state.userPrompts)) {
            if (prompt.monitorId === monitorId) delete state.userPrompts[id];
          }
          for (const [agentId, entry] of Object.entries(state.cliStreaming)) {
            if (entry.monitorId === monitorId) delete state.cliStreaming[agentId];
          }

          // Bound to a window, and a window belongs to exactly one monitor. `windowAgents`
          // is keyed by agentId, so the window to attribute by is in the value.
          for (const [agentId, agent] of Object.entries(state.windowAgents)) {
            if (onThisMonitor(agent.windowId)) delete state.windowAgents[agentId];
          }
          for (const windowId of Object.keys(state.queuedActions)) {
            if (onThisMonitor(windowId)) delete state.queuedActions[windowId];
          }

          // Agent-keyed: only the agents the map could actually place. An unplaceable
          // agent keeps its spinner — see the "attribute, then clear" rule above.
          for (const agentId of Object.keys(state.activeAgents)) {
            if (agentMonitors.get(agentId) === monitorId) delete state.activeAgents[agentId];
          }
          for (const [messageId, status] of Object.entries(state.messageStatuses)) {
            if (status.agentId && agentMonitors.get(status.agentId) === monitorId) {
              delete state.messageStatuses[messageId];
            }
          }

          // Outbound drain queues: drop this monitor's items, keep everything else —
          // including items with no window to attribute them by.
          state.pendingFeedback = state.pendingFeedback.filter((f) => !onThisMonitor(f.windowId));
          state.pendingAppProtocolResponses = state.pendingAppProtocolResponses.filter(
            (r) => !onThisMonitor(r.windowId),
          );
          state.pendingAppInteractions = state.pendingAppInteractions.filter(
            (i) => !onThisMonitor(i.windowId),
          );
          state.pendingAppEvents = state.pendingAppEvents.filter((e) => !onThisMonitor(e.windowId));
          state.pendingInteractions = state.pendingInteractions.filter((i) => {
            if (i.monitorId) return i.monitorId !== monitorId;
            return i.windowId ? !onThisMonitor(i.windowId) : true;
          });

          // Deliberately untouched when scoped:
          //  - toasts, dialogs, selectedWindowIds, attachedImages, activityLog —
          //    transient or session-wide shell UI, with no monitor identity to scope by.
          //  - notifications — the model carries no monitorId (`notification.show` does not
          //    send one), so there is nothing to filter on; the notification center is a
          //    session-wide surface.
          //  - pendingGestureMessages — plain strings, unattributable, and each one is an
          //    unsent user utterance.
        });
        return;
      }

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
