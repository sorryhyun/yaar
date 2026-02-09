/**
 * Desktop state - everything that can appear on screen.
 */
import type { WindowBounds, WindowContent, OSAction } from '@yaar/shared'

export interface WindowModel {
  id: string
  title: string
  bounds: WindowBounds
  content: WindowContent
  minimized: boolean
  maximized: boolean
  previousBounds?: WindowBounds  // For restore after maximize
  locked?: boolean
  lockedBy?: string  // Agent ID that holds the lock
  requestId?: string  // For tracking iframe feedback
  monitorId?: string  // Which monitor this window belongs to
}

export interface CliEntry {
  id: string
  type: 'user' | 'thinking' | 'response' | 'tool' | 'error' | 'action-summary'
  content: string
  agentId?: string
  monitorId: string
  timestamp: number
}

export interface Monitor {
  id: string
  label: string
  createdAt: number
}

export interface NotificationModel {
  id: string
  title: string
  body: string
  icon?: string
  duration?: number
  timestamp: number
}

export interface ToastModel {
  id: string
  message: string
  variant: 'info' | 'success' | 'warning' | 'error'
  timestamp: number
  action?: { label: string; eventId: string }
  duration?: number
}

import type { PermissionOptions } from '@yaar/shared'

export interface DialogModel {
  id: string
  title: string
  message: string
  confirmText: string
  cancelText: string
  timestamp: number
  permissionOptions?: PermissionOptions
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface ContextMenuState {
  x: number
  y: number
  windowId?: string
  windowTitle?: string
}

export interface RestorePrompt {
  sessionId: string
  sessionDate: string
}

export interface DebugEntry {
  id: string
  timestamp: number
  direction: 'in' | 'out'
  type: string
  data: unknown
}

export interface ActiveAgent {
  id: string
  status: string  // e.g., "Thinking...", "Running: read_file"
  startedAt: number
}

export interface WindowAgent {
  agentId: string
  windowId: string
  status: 'assigned' | 'active' | 'released'
}

export interface RenderingFeedback {
  requestId: string
  windowId: string
  renderer: string
  success: boolean
  error?: string
  url?: string
  locked?: boolean
  imageData?: string
}

import type { UserInteraction } from '@yaar/shared'

export interface QueuedComponentAction {
  windowId: string
  windowTitle: string
  action: string
  parallel?: boolean
  formData?: Record<string, string | number | boolean>
  formId?: string
  componentPath?: string[]
  queuedAt: number
}

export interface DesktopState {
  // Windows managed by the AI
  windows: Record<string, WindowModel>
  zOrder: string[]  // Window IDs in stacking order (last = top)
  focusedWindowId: string | null

  // Notifications & Toasts
  notifications: Record<string, NotificationModel>
  toasts: Record<string, ToastModel>

  // Confirmation dialogs
  dialogs: Record<string, DialogModel>

  // Connection to AI backend
  connectionStatus: ConnectionStatus
  connectionError: string | null

  // Session tracking
  providerType: string | null
  sessionId: string | null

  // Activity log (debugging)
  activityLog: OSAction[]

  // Debug log (raw WebSocket events)
  debugLog: DebugEntry[]
  debugPanelOpen: boolean

  // Recent actions panel
  recentActionsPanelOpen: boolean

  // Context menu state
  contextMenu: ContextMenuState | null

  // Sessions modal
  sessionsModalOpen: boolean

  // Restore prompt
  restorePrompt: RestorePrompt | null

  // Active agents (for spinner display)
  activeAgents: Record<string, ActiveAgent>

  // Agent panel expanded state
  agentPanelOpen: boolean

  // Window agents (for fork session feature)
  windowAgents: Record<string, WindowAgent>

  // Pending feedback to send to the server
  pendingFeedback: RenderingFeedback[]

  // Pending user interactions to send to the server
  pendingInteractions: UserInteraction[]

  // Queued component actions for locked windows
  queuedActions: Record<string, QueuedComponentAction[]>
}

export interface DesktopActions {
  // Apply an OS action from the AI
  applyAction: (action: OSAction) => void
  applyActions: (actions: OSAction[]) => void

  // Connection management
  setConnectionStatus: (status: ConnectionStatus, error?: string) => void
  setSession: (providerType: string, sessionId: string) => void

  // User-initiated actions
  userFocusWindow: (windowId: string) => void
  userCloseWindow: (windowId: string) => void
  userMoveWindow: (windowId: string, x: number, y: number) => void
  userResizeWindow: (windowId: string, w: number, h: number) => void

  // Dismissals
  dismissToast: (id: string) => void
  dismissNotification: (id: string) => void

  // Dialogs
  respondToDialog: (id: string, confirmed: boolean) => void

  // Debug panel
  addDebugEntry: (entry: Omit<DebugEntry, 'id' | 'timestamp'>) => void
  toggleDebugPanel: () => void
  clearDebugLog: () => void

  // Recent actions panel
  toggleRecentActionsPanel: () => void
  clearActivityLog: () => void

  // Context menu
  showContextMenu: (x: number, y: number, windowId?: string) => void
  hideContextMenu: () => void

  // Sessions modal
  toggleSessionsModal: () => void

  // Restore prompt
  setRestorePrompt: (prompt: RestorePrompt | null) => void
  dismissRestorePrompt: () => void

  // Active agents
  setAgentActive: (agentId: string, status: string) => void
  clearAgent: (agentId: string) => void
  clearAllAgents: () => void
  toggleAgentPanel: () => void

  // Window agents
  registerWindowAgent: (windowId: string, agentId: string, status: WindowAgent['status']) => void
  updateWindowAgentStatus: (windowId: string, status: WindowAgent['status']) => void
  removeWindowAgent: (windowId: string) => void

  // Rendering feedback
  addRenderingFeedback: (feedback: RenderingFeedback) => void
  consumePendingFeedback: () => RenderingFeedback[]

  // Pending user interactions
  consumePendingInteractions: () => UserInteraction[]

  // Queued component actions
  queueComponentAction: (action: QueuedComponentAction) => void
  consumeQueuedActions: (windowId: string) => QueuedComponentAction[]
  clearQueuedActions: (windowId: string) => void
}
