/**
 * Types for the Zustand store slices.
 * Each slice has its own state and actions interface.
 */
import type { StateCreator } from 'zustand'
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
} from '@/types/state'
import type { OSAction, UserInteraction } from '@claudeos/shared'

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
}

// ============ Slice State Types ============

export interface WindowsSliceState {
  windows: Record<string, WindowModel>
  zOrder: string[]
  focusedWindowId: string | null
}

export interface WindowsSliceActions {
  userFocusWindow: (windowId: string) => void
  userCloseWindow: (windowId: string) => void
  userMoveWindow: (windowId: string, x: number, y: number) => void
  userResizeWindow: (windowId: string, w: number, h: number) => void
  handleWindowAction: (action: OSAction) => void
}

export type WindowsSlice = WindowsSliceState & WindowsSliceActions

export interface NotificationsSliceState {
  notifications: Record<string, NotificationModel>
}

export interface NotificationsSliceActions {
  dismissNotification: (id: string) => void
  handleNotificationAction: (action: OSAction) => void
}

export type NotificationsSlice = NotificationsSliceState & NotificationsSliceActions

export interface ToastsSliceState {
  toasts: Record<string, ToastModel>
}

export interface ToastsSliceActions {
  dismissToast: (id: string) => void
  handleToastAction: (action: OSAction) => void
}

export type ToastsSlice = ToastsSliceState & ToastsSliceActions

export interface DialogsSliceState {
  dialogs: Record<string, DialogModel>
}

export interface DialogsSliceActions {
  respondToDialog: (id: string, confirmed: boolean) => void
  handleDialogAction: (action: OSAction) => void
}

export type DialogsSlice = DialogsSliceState & DialogsSliceActions

export interface ConnectionSliceState {
  connectionStatus: ConnectionStatus
  connectionError: string | null
  providerType: string | null
  sessionId: string | null
}

export interface ConnectionSliceActions {
  setConnectionStatus: (status: ConnectionStatus, error?: string) => void
  setSession: (providerType: string, sessionId: string) => void
}

export type ConnectionSlice = ConnectionSliceState & ConnectionSliceActions

export interface DebugSliceState {
  activityLog: OSAction[]
  debugLog: DebugEntry[]
  debugPanelOpen: boolean
  recentActionsPanelOpen: boolean
}

export interface DebugSliceActions {
  addDebugEntry: (entry: Omit<DebugEntry, 'id' | 'timestamp'>) => void
  toggleDebugPanel: () => void
  clearDebugLog: () => void
  toggleRecentActionsPanel: () => void
  clearActivityLog: () => void
  addToActivityLog: (action: OSAction) => void
}

export type DebugSlice = DebugSliceState & DebugSliceActions

export interface AgentsSliceState {
  activeAgents: Record<string, ActiveAgent>
  agentPanelOpen: boolean
  windowAgents: Record<string, WindowAgent>
}

export interface AgentsSliceActions {
  setAgentActive: (agentId: string, status: string) => void
  clearAgent: (agentId: string) => void
  clearAllAgents: () => void
  toggleAgentPanel: () => void
  registerWindowAgent: (windowId: string, agentId: string, status: WindowAgent['status']) => void
  updateWindowAgentStatus: (windowId: string, status: WindowAgent['status']) => void
  removeWindowAgent: (windowId: string) => void
}

export type AgentsSlice = AgentsSliceState & AgentsSliceActions

export interface UiSliceState {
  contextMenu: ContextMenuState | null
  sessionsModalOpen: boolean
  restorePrompt: RestorePrompt | null
}

export interface UiSliceActions {
  showContextMenu: (x: number, y: number, windowId?: string) => void
  hideContextMenu: () => void
  toggleSessionsModal: () => void
  setRestorePrompt: (prompt: RestorePrompt | null) => void
  dismissRestorePrompt: () => void
}

export type UiSlice = UiSliceState & UiSliceActions

export interface FeedbackSliceState {
  pendingFeedback: RenderingFeedback[]
}

export interface FeedbackSliceActions {
  addRenderingFeedback: (feedback: RenderingFeedback) => void
  consumePendingFeedback: () => RenderingFeedback[]
  addPendingFeedback: (feedback: RenderingFeedback) => void
}

export type FeedbackSlice = FeedbackSliceState & FeedbackSliceActions

export interface InteractionsSliceState {
  interactionLog: UserInteraction[]
}

export interface InteractionsSliceActions {
  logInteraction: (interaction: Omit<UserInteraction, 'timestamp'>) => void
  consumeInteractions: () => UserInteraction[]
}

export type InteractionsSlice = InteractionsSliceState & InteractionsSliceActions

export interface QueuedActionsSliceState {
  queuedActions: Record<string, QueuedComponentAction[]>
}

export interface QueuedActionsSliceActions {
  queueComponentAction: (action: QueuedComponentAction) => void
  consumeQueuedActions: (windowId: string) => QueuedComponentAction[]
  clearQueuedActions: (windowId: string) => void
}

export type QueuedActionsSlice = QueuedActionsSliceState & QueuedActionsSliceActions

export interface DrawingSliceState {
  hasDrawing: boolean
  canvasDataUrl: string | null
}

export interface DrawingSliceActions {
  saveDrawing: (dataUrl: string) => void
  clearDrawing: () => void
  consumeDrawing: () => string | null
}

export type DrawingSlice = DrawingSliceState & DrawingSliceActions

// ============ Combined Store Type ============

export type DesktopStore = WindowsSlice &
  NotificationsSlice &
  ToastsSlice &
  DialogsSlice &
  ConnectionSlice &
  DebugSlice &
  AgentsSlice &
  UiSlice &
  FeedbackSlice &
  InteractionsSlice &
  QueuedActionsSlice &
  DrawingSlice & {
    applyAction: (action: OSAction) => void
    applyActions: (actions: OSAction[]) => void
  }

// ============ Slice Creator Type ============

// Type for creating slices with immer middleware
export type SliceCreator<T> = StateCreator<
  DesktopStore,
  [['zustand/immer', never]],
  [],
  T
>

// Legacy type compatibility
export type DesktopStoreType = DesktopState & DesktopActions
