/**
 * The combined store type. Each slice declares its own `XSliceState` /
 * `XSliceActions` / `XSlice` beside its implementation; this file only
 * intersects them, because cross-slice access (and `SliceCreator`) needs the
 * whole shape in one place.
 */
import type { StateCreator } from 'zustand';
import type { WindowsSlice } from './slices/windowsSlice';
import type { NotificationsSlice } from './slices/notificationsSlice';
import type { ToastsSlice } from './slices/toastsSlice';
import type { DialogsSlice } from './slices/dialogsSlice';
import type { UserPromptsSlice } from './slices/userPromptsSlice';
import type { ConnectionSlice } from './slices/connectionSlice';
import type { DebugSlice } from './slices/debugSlice';
import type { AgentsSlice } from './slices/agentsSlice';
import type { UiSlice } from './slices/uiSlice';
import type { SettingsSlice } from './slices/settingsSlice';
import type { FeedbackSlice } from './slices/feedbackSlice';
import type { InteractionsSlice } from './slices/interactionsSlice';
import type { QueuedActionsSlice } from './slices/queuedActionsSlice';
import type { DrawingSlice } from './slices/drawingSlice';
import type { ImageAttachSlice } from './slices/imageAttachSlice';
import type { CliSlice } from './slices/cliSlice';
import type { MonitorSlice } from './slices/monitorSlice';
import type { MessageStatusSlice } from './slices/messageStatusSlice';
import type { OutboxSlice } from './slices/outboxSlice';
import type {
  WindowModel,
  NotificationModel,
  ToastModel,
  DialogModel,
  UserPromptModel,
  ConnectionStatus,
  RestorePrompt,
  ActiveAgent,
  WindowAgent,
  RenderingFeedback,
  QueuedComponentAction,
  CliEntry,
  Monitor,
} from '@/types/state';
import type { OSAction, DesktopShortcut, ActiveAgentSnapshot } from '@yaar/shared';

// Re-export for convenience
export type {
  WindowModel,
  NotificationModel,
  ToastModel,
  DialogModel,
  UserPromptModel,
  ConnectionStatus,
  RestorePrompt,
  ActiveAgent,
  WindowAgent,
  RenderingFeedback,
  QueuedComponentAction,
  CliEntry,
  Monitor,
};

// ============ Combined Store Type ============

export type DesktopStore = WindowsSlice &
  NotificationsSlice &
  ToastsSlice &
  DialogsSlice &
  UserPromptsSlice &
  ConnectionSlice &
  DebugSlice &
  AgentsSlice &
  UiSlice &
  SettingsSlice &
  FeedbackSlice &
  InteractionsSlice &
  QueuedActionsSlice &
  DrawingSlice &
  ImageAttachSlice &
  CliSlice &
  MonitorSlice &
  MessageStatusSlice &
  OutboxSlice & {
    appBadges: Record<string, number>;
    appsVersion: number;
    /**
     * Declared keybinding combos per installed app id, straight from each app's
     * protocol manifest. The shell consults it before claiming a global combo —
     * see `resolveCloseTopWindow` — so it needs the table synchronously, which
     * rules out asking the iframe over postMessage.
     */
    appKeybindings: Record<string, string[]>;
    shortcuts: DesktopShortcut[];
    setShortcuts: (shortcuts: DesktopShortcut[]) => void;
    setAppKeybindings: (keybindings: Record<string, string[]>) => void;
    bumpAppsVersion: () => void;
    applyAction: (action: OSAction) => void;
    applyActions: (actions: OSAction[]) => void;
    /**
     * Converge on the server's answer to "what is actually here" — including, crucially,
     * what is *not*. See `applySnapshot` in `desktop.ts`.
     */
    applySnapshot: (actions: OSAction[], agents: ActiveAgentSnapshot[]) => void;
    /**
     * Clear context, keep the screen. With a `monitorId` only that monitor's state goes;
     * without one it is the session-wide clear. See `resetDesktop` in `desktop.ts`.
     */
    resetDesktop: (monitorId?: string) => void;
    clearDesktop: () => void;
  };

// ============ Slice Creator Type ============

// Type for creating slices with immer middleware
export type SliceCreator<T> = StateCreator<DesktopStore, [['zustand/immer', never]], [], T>;
