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
  UserPromptModel,
  ConnectionStatus,
  RestorePrompt,
  DebugEntry,
  ActiveAgent,
  WindowAgent,
  RenderingFeedback,
  QueuedComponentAction,
  CliEntry,
  Monitor,
} from '@/types/state';
import type {
  OSAction,
  WindowAction,
  UserInteraction,
  AppProtocolResponse,
  DesktopShortcut,
  WindowBounds,
  RecoveryMode,
  ClientEvent,
  ActiveAgentSnapshot,
} from '@yaar/shared';

// Re-export for convenience
export type {
  WindowModel,
  NotificationModel,
  ToastModel,
  DialogModel,
  UserPromptModel,
  ConnectionStatus,
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
  userSnapWindow: (windowId: string, bounds: WindowBounds) => void;
  handleWindowAction: (action: WindowAction) => void;
  queueBoundsUpdate: (windowId: string, action?: 'window.move' | 'window.resize') => void;
  /** Swap a window's iframe token, but only if it still carries the one we expected. */
  replaceIframeToken: (windowId: string, expected: string, token: string) => void;
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

export interface UserPromptsSliceState {
  userPrompts: Record<string, UserPromptModel>;
}

export interface UserPromptsSliceActions {
  handleUserPromptAction: (action: OSAction) => void;
  dismissUserPrompt: (id: string) => void;
}

export type UserPromptsSlice = UserPromptsSliceState & UserPromptsSliceActions;

export interface ConnectionSliceState {
  connectionStatus: ConnectionStatus;
  connectionError: string | null;
  providerType: string | null;
  sessionId: string | null;
  /** Incarnation of `sessionId` this connection is bound to. Null until attached. */
  sessionEpoch: number | null;
  /** This tab's connection id on the server. Null until attached. */
  connectionId: string | null;
  /** What the server did with the session id we asked for. Null until attached. */
  recoveryMode: RecoveryMode | null;
}

export interface ConnectionSliceActions {
  setConnectionStatus: (status: ConnectionStatus, error?: string) => void;
  setSession: (providerType: string, sessionId: string) => void;
  setAttachment: (attachment: {
    sessionId: string;
    sessionEpoch: number;
    connectionId: string;
    recoveryMode: RecoveryMode;
    provider?: string;
  }) => void;
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
  incrementSubagentCount: (agentId: string) => void;
  decrementSubagentCount: (agentId: string) => void;
}

export type AgentsSlice = AgentsSliceState & AgentsSliceActions;

export interface UiSliceState {
  sessionsModalOpen: boolean;
  restorePrompt: RestorePrompt | null;
  selectedWindowIds: string[];
}

export interface UiSliceActions {
  toggleSessionsModal: () => void;
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
  applyServerSettings: (settings: Partial<SettingsSliceState>) => void;
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
  instructions?: string;
  toMonitor?: boolean;
}

export interface AppEventItem {
  windowId: string;
  channel: string;
  payload: unknown;
}

export interface FeedbackSliceState {
  pendingFeedback: RenderingFeedback[];
  pendingAppProtocolResponses: AppProtocolResponseItem[];
  pendingAppInteractions: AppInteractionItem[];
  pendingAppEvents: AppEventItem[];
}

export interface FeedbackSliceActions {
  addRenderingFeedback: (feedback: RenderingFeedback) => void;
  consumePendingFeedback: () => RenderingFeedback[];
  addPendingFeedback: (feedback: RenderingFeedback) => void;
  addPendingAppProtocolResponse: (item: AppProtocolResponseItem) => void;
  consumePendingAppProtocolResponses: () => AppProtocolResponseItem[];
  addPendingAppInteraction: (item: AppInteractionItem) => void;
  consumePendingAppInteractions: () => AppInteractionItem[];
  addPendingAppEvent: (item: AppEventItem) => void;
  consumePendingAppEvents: () => AppEventItem[];
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
  /**
   * Routing target for typed messages, chosen from the CLI-panel toggle:
   *  - `'monitor'` (default) — the monitor agent, sandbox browsing only.
   *  - `'session'` — the session agent ("act as me"), which can drive the
   *    user's real browser.
   */
  cliTarget: 'monitor' | 'session';
}

export interface CliSliceActions {
  toggleCliMode: () => void;
  setCliTarget: (target: 'monitor' | 'session') => void;
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
  restoreCliHistory: (
    entries: {
      type: CliEntry['type'];
      content: string;
      agentId?: string;
      monitorId: string;
      timestamp: number;
    }[],
  ) => void;
}

export type CliSlice = CliSliceState & CliSliceActions;

export interface MonitorSliceState {
  monitors: Monitor[];
  activeMonitorId: string;
}

export interface MonitorSliceActions {
  /** Ask the server for a new monitor; it mints the id and answers with MONITORS. */
  createMonitor: () => void;
  /** Ask the server to delete a monitor; the list comes back on MONITORS. */
  removeMonitor: (id: string) => void;
  /** Apply the session's authoritative monitor list. `focus` switches this tab to it. */
  setMonitors: (monitors: { id: string; label: string }[], focus?: string) => void;
  switchMonitor: (id: string) => void;
}

export type MonitorSlice = MonitorSliceState & MonitorSliceActions;

export interface MessageStatus {
  /**
   * - `unsent` — the socket was not open; it sits in the outbox awaiting a retry.
   * - `sent` — it went out; the server has not answered yet.
   * - `queued` / `accepted` — the server has it.
   * - `failed` — the server named this message and said it will not run.
   */
  status: 'unsent' | 'sent' | 'accepted' | 'queued' | 'failed';
  agentId?: string;
  position?: number;
  error?: string;
  timestamp: number;
}

export interface MessageStatusSliceState {
  messageStatuses: Record<string, MessageStatus>;
}

export interface MessageStatusSliceActions {
  trackMessage: (messageId: string, status?: MessageStatus['status']) => void;
  acceptMessage: (messageId: string, agentId: string) => void;
  queueMessage: (messageId: string, position: number) => void;
  failMessage: (messageId: string, error: string) => void;
  clearMessageStatus: (messageId: string) => void;
  clearAllMessageStatuses: () => void;
}

export type MessageStatusSlice = MessageStatusSliceState & MessageStatusSliceActions;

// ============ Outbox ============

/** A command held until the server acknowledges it. See `slices/outboxSlice.ts`. */
export interface OutboxEntry {
  messageId: string;
  event: ClientEvent;
  queuedAt: number;
}

export interface OutboxSliceState {
  outbox: OutboxEntry[];
}

export interface OutboxSliceActions {
  enqueueOutbox: (messageId: string, event: ClientEvent) => void;
  settleOutbox: (messageId: string) => void;
  pendingOutbox: () => OutboxEntry[];
  clearOutbox: () => void;
}

export type OutboxSlice = OutboxSliceState & OutboxSliceActions;

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
    shortcuts: DesktopShortcut[];
    setShortcuts: (shortcuts: DesktopShortcut[]) => void;
    bumpAppsVersion: () => void;
    applyAction: (action: OSAction) => void;
    applyActions: (actions: OSAction[]) => void;
    /**
     * Converge on the server's answer to "what is actually here" — including, crucially,
     * what is *not*. See `applySnapshot` in `desktop.ts`.
     */
    applySnapshot: (actions: OSAction[], agents: ActiveAgentSnapshot[]) => void;
    resetDesktop: () => void;
    clearDesktop: () => void;
  };

// ============ Slice Creator Type ============

// Type for creating slices with immer middleware
export type SliceCreator<T> = StateCreator<DesktopStore, [['zustand/immer', never]], [], T>;

// Legacy type compatibility
export type DesktopStoreType = DesktopState & DesktopActions;
