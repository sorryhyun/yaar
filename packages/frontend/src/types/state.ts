/**
 * Desktop state - everything that can appear on screen.
 */
import type { WindowBounds, WindowContent, OSAction } from '@claudeos/shared'

export interface WindowModel {
  id: string
  title: string
  bounds: WindowBounds
  content: WindowContent
  minimized: boolean
  maximized: boolean
  previousBounds?: WindowBounds  // For restore after maximize
}

export interface NotificationModel {
  id: string
  title: string
  body: string
  icon?: string
  timestamp: number
}

export interface ToastModel {
  id: string
  message: string
  variant: 'info' | 'success' | 'warning' | 'error'
  timestamp: number
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface DesktopState {
  // Windows managed by the AI
  windows: Record<string, WindowModel>
  zOrder: string[]  // Window IDs in stacking order (last = top)
  focusedWindowId: string | null

  // Notifications & Toasts
  notifications: Record<string, NotificationModel>
  toasts: Record<string, ToastModel>

  // Connection to AI backend
  connectionStatus: ConnectionStatus
  connectionError: string | null

  // Session tracking
  providerType: string | null
  sessionId: string | null

  // Activity log (debugging)
  activityLog: OSAction[]
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
}
