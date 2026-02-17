/**
 * Types for the Zustand store slices.
 * Each slice has its own state and actions interface.
 */
import type { StateCreator } from 'zustand';
import type {
  DesktopState,
  DesktopActions,
  WindowModel,
  NotificationModel,
  ToastModel,
  DialogModel,
  ConnectionStatus,
  ContextMenuState,
  RestorePrompt,
  DebugEntry,
  ActiveAgent,
  WindowAgent,
  RenderingFeedback,
  QueuedComponentAction,
  CliEntry,
  Monitor,
} from '@/types/state';
import type { OSAction, UserInteraction, AppProtocolResponse, DesktopShortcut } from '@yaar/shared';

// Re-export for convenience
export type {
  WindowModel,
  NotificationModel,
  ToastModel,
  DialogModel,
  ConnectionStatus,
  ContextMenuState,
  RestorePrompt,
  DebugEntry,
  ActiveAgent,
  WindowAgent,
  RenderingFeedback,
  QueuedComponentAction,
  CliEntry,
  Monitor,
};

// ============ Slice State Types ============

export interface WindowsSliceState {
  windows: Record<string, WindowModel>;
  zOrder: string[];
  focusedWindowId: string | null;
}

export interface WindowsSliceActions {
  userFocusWindow: (windowId: string) => void;
  userCloseWindow: (windowId: string) => void;
  userMoveWindow: (windowId: string, x: number, y: number) => void;
  userResizeWindow: (windowId: string, w: number, h: number, x?: number, y?: number) => void;
  handleWindowAction: (action: OSAction) => void;
  queueBoundsUpdate: (windowId: string) => void;
}

export type WindowsSlice = WindowsSliceState & WindowsSliceActions;

export interface NotificationsSliceState {
  notifications: Record<string, NotificationModel>;
}

export interface NotificationsSliceActions {
  dismissNotification: (id: string) => void;
  handleNotificationAction: (action: OSAction) => void;
}

export type NotificationsSlice = NotificationsSliceState & NotificationsSliceActions;

export interface ToastsSliceState {
  toasts: Record<string, ToastModel>;
}

export interface ToastsSliceActions {
  dismissToast: (id: string) => void;
  handleToastAction: (action: OSAction) => void;
}

export type ToastsSlice = ToastsSliceState & ToastsSliceActions;

export interface DialogsSliceState {
  dialogs: Record<string, DialogModel>;
}

export interface DialogsSliceActions {
  respondToDialog: (id: string, confirmed: boolean) => void;
  handleDialogAction: (action: OSAction) => void;
}

export type DialogsSlice = DialogsSliceState & DialogsSliceActions;

export interface ConnectionSliceState {
  connectionStatus: ConnectionStatus;
  connectionError: string | null;
  providerType: string | null;
  sessionId: string | null;
}

export interface ConnectionSliceActions {
  setConnectionStatus: (status: ConnectionStatus, error?: string) => void;
  setSession: (providerType: string, sessionId: string) => void;
}

export type ConnectionSlice = ConnectionSliceState & ConnectionSliceActions;

export interface DebugSliceState {
  activityLog: OSAction[];
  debugLog: DebugEntry[];
  debugPanelOpen: boolean;
  recentActionsPanelOpen: boolean;
}

export interface DebugSliceActions {
  addDebugEntry: (entry: Omit<DebugEntry, 'id' | 'timestamp'>) => void;
  toggleDebugPanel: () => void;
  clearDebugLog: () => void;
  toggleRecentActionsPanel: () => void;
  clearActivityLog: () => void;
  addToActivityLog: (action: OSAction) => void;
}

export type DebugSlice = DebugSliceState & DebugSliceActions;

export interface AgentsSliceState {
  activeAgents: Record<string, ActiveAgent>;
  agentPanelOpen: boolean;
  windowAgents: Record<string, WindowAgent>;
}

export interface AgentsSliceActions {
  setAgentActive: (agentId: string, status: string) => void;
  clearAgent: (agentId: string) => void;
  clearAllAgents: () => void;
  toggleAgentPanel: () => void;
  registerWindowAgent: (windowId: string, agentId: string, status: WindowAgent['status']) => void;
  updateWindowAgentStatus: (agentId: string, status: WindowAgent['status']) => void;
  removeWindowAgent: (windowId: string) => void;
}

export type AgentsSlice = AgentsSliceState & AgentsSliceActions;

export interface UiSliceState {
  contextMenu: ContextMenuState | null;
  sessionsModalOpen: boolean;
  settingsModalOpen: boolean;
  restorePrompt: RestorePrompt | null;
  selectedWindowIds: string[];
}

export interface UiSliceActions {
  showContextMenu: (x: number, y: number, windowId?: string) => void;
  hideContextMenu: () => void;
  toggleSessionsModal: () => void;
  toggleSettingsModal: () => void;
  setRestorePrompt: (prompt: RestorePrompt | null) => void;
  dismissRestorePrompt: () => void;
  setSelectedWindows: (ids: string[]) => void;
}

export type UiSlice = UiSliceState & UiSliceActions;

export interface SettingsSliceState {
  userName: string;
  language: string;
  wallpaper: string;
  accentColor: string;
  iconSize: 'small' | 'medium' | 'large';
}

export interface SettingsSliceActions {
  setUserName: (name: string) => void;
  setLanguage: (lang: string) => void;
  applyServerLanguage: (lang: string) => void;
  setWallpaper: (value: string) => void;
  setAccentColor: (key: string) => void;
  setIconSize: (size: 'small' | 'medium' | 'large') => void;
}

export type SettingsSlice = SettingsSliceState & SettingsSliceActions;

export interface AppProtocolResponseItem {
  requestId: string;
  windowId: string;
  response: AppProtocolResponse;
}

export interface AppInteractionItem {
  windowId: string;
  content: string;
}

export interface FeedbackSliceState {
  pendingFeedback: RenderingFeedback[];
  pendingAppProtocolResponses: AppProtocolResponseItem[];
  pendingAppProtocolReady: string[];
  pendingAppInteractions: AppInteractionItem[];
}

export interface FeedbackSliceActions {
  addRenderingFeedback: (feedback: RenderingFeedback) => void;
  consumePendingFeedback: () => RenderingFeedback[];
  addPendingFeedback: (feedback: RenderingFeedback) => void;
  addPendingAppProtocolResponse: (item: AppProtocolResponseItem) => void;
  consumePendingAppProtocolResponses: () => AppProtocolResponseItem[];
  addAppProtocolReady: (windowId: string) => void;
  consumeAppProtocolReady: () => string[];
  addPendingAppInteraction: (item: AppInteractionItem) => void;
  consumePendingAppInteractions: () => AppInteractionItem[];
}

export type FeedbackSlice = FeedbackSliceState & FeedbackSliceActions;

export interface InteractionsSliceState {
  pendingInteractions: UserInteraction[];
  pendingGestureMessages: string[];
}

export interface InteractionsSliceActions {
  consumePendingInteractions: () => UserInteraction[];
  queueGestureMessage: (content: string) => void;
  consumeGestureMessages: () => string[];
}

export type InteractionsSlice = InteractionsSliceState & InteractionsSliceActions;

export interface QueuedActionsSliceState {
  queuedActions: Record<string, QueuedComponentAction[]>;
}

export interface QueuedActionsSliceActions {
  queueComponentAction: (action: QueuedComponentAction) => void;
  consumeQueuedActions: (windowId: string) => QueuedComponentAction[];
  clearQueuedActions: (windowId: string) => void;
}

export type QueuedActionsSlice = QueuedActionsSliceState & QueuedActionsSliceActions;

export interface DrawingSliceState {
  hasDrawing: boolean;
  canvasDataUrl: string | null;
  pencilMode: boolean;
}

export interface DrawingSliceActions {
  saveDrawing: (dataUrl: string) => void;
  clearDrawing: () => void;
  consumeDrawing: () => string | null;
  togglePencilMode: () => void;
  setPencilMode: (active: boolean) => void;
}

export type DrawingSlice = DrawingSliceState & DrawingSliceActions;

export interface ImageAttachSliceState {
  attachedImages: string[];
}

export interface ImageAttachSliceActions {
  addAttachedImages: (images: string[]) => void;
  removeAttachedImage: (index: number) => void;
  clearAttachedImages: () => void;
  consumeAttachedImages: () => string[];
}

export type ImageAttachSlice = ImageAttachSliceState & ImageAttachSliceActions;

export interface CliSliceState {
  cliMode: boolean;
  cliHistory: Record<string, CliEntry[]>;
  cliStreaming: Record<string, CliEntry>;
}

export interface CliSliceActions {
  toggleCliMode: () => void;
  addCliEntry: (entry: {
    type: CliEntry['type'];
    content: string;
    agentId?: string;
    monitorId?: string;
  }) => void;
  updateCliStreaming: (
    agentId: string,
    content: string,
    type: 'thinking' | 'response',
    monitorId?: string,
  ) => void;
  finalizeCliStreaming: (agentId: string) => void;
  clearCliHistory: (monitorId?: string) => void;
}

export type CliSlice = CliSliceState & CliSliceActions;

export interface MonitorSliceState {
  monitors: Monitor[];
  activeMonitorId: string;
}

export interface MonitorSliceActions {
  createMonitor: () => string;
  removeMonitor: (id: string) => void;
  switchMonitor: (id: string) => void;
}

export type MonitorSlice = MonitorSliceState & MonitorSliceActions;

// ============ Combined Store Type ============

export type DesktopStore = WindowsSlice &
  NotificationsSlice &
  ToastsSlice &
  DialogsSlice &
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
  MonitorSlice & {
    appBadges: Record<string, number>;
    appsVersion: number;
    shortcuts: DesktopShortcut[];
    bumpAppsVersion: () => void;
    applyAction: (action: OSAction) => void;
    applyActions: (actions: OSAction[]) => void;
    resetDesktop: () => void;
  };

// ============ Slice Creator Type ============

// Type for creating slices with immer middleware
export type SliceCreator<T> = StateCreator<DesktopStore, [['zustand/immer', never]], [], T>;

// Legacy type compatibility
export type DesktopStoreType = DesktopState & DesktopActions;
