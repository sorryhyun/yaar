/**
 * OS Actions DSL - The language the AI uses to control the desktop.
 *
 * When the AI decides to show something, it emits these actions.
 * The frontend applies them to create windows, toasts, and notifications.
 */

// ============ Window Actions ============

export interface WindowBounds {
  x: number
  y: number
  w: number
  h: number
}

export interface WindowContent {
  renderer: string  // 'markdown', 'table', 'html', 'text'
  data: unknown
}

export interface WindowCreateAction {
  type: 'window.create'
  windowId: string
  title: string
  bounds: WindowBounds
  content: WindowContent
}

export interface WindowCloseAction {
  type: 'window.close'
  windowId: string
}

export interface WindowFocusAction {
  type: 'window.focus'
  windowId: string
}

export interface WindowMinimizeAction {
  type: 'window.minimize'
  windowId: string
}

export interface WindowMaximizeAction {
  type: 'window.maximize'
  windowId: string
}

export interface WindowRestoreAction {
  type: 'window.restore'
  windowId: string
}

export interface WindowMoveAction {
  type: 'window.move'
  windowId: string
  x: number
  y: number
}

export interface WindowResizeAction {
  type: 'window.resize'
  windowId: string
  w: number
  h: number
}

export interface WindowSetTitleAction {
  type: 'window.setTitle'
  windowId: string
  title: string
}

export interface WindowSetContentAction {
  type: 'window.setContent'
  windowId: string
  content: WindowContent
}

// ============ Notification Actions ============

export interface NotificationShowAction {
  type: 'notification.show'
  id: string
  title: string
  body: string
  icon?: string
}

export interface NotificationDismissAction {
  type: 'notification.dismiss'
  id: string
}

// ============ Toast Actions ============

export interface ToastShowAction {
  type: 'toast.show'
  id: string
  message: string
  variant?: 'info' | 'success' | 'warning' | 'error'
}

export interface ToastDismissAction {
  type: 'toast.dismiss'
  id: string
}

// ============ Union Type ============

export type WindowAction =
  | WindowCreateAction
  | WindowCloseAction
  | WindowFocusAction
  | WindowMinimizeAction
  | WindowMaximizeAction
  | WindowRestoreAction
  | WindowMoveAction
  | WindowResizeAction
  | WindowSetTitleAction
  | WindowSetContentAction

export type NotificationAction =
  | NotificationShowAction
  | NotificationDismissAction

export type ToastAction =
  | ToastShowAction
  | ToastDismissAction

export type OSAction = WindowAction | NotificationAction | ToastAction

// ============ Type Guards ============

export function isWindowAction(action: OSAction): action is WindowAction {
  return action.type.startsWith('window.')
}

export function isNotificationAction(action: OSAction): action is NotificationAction {
  return action.type.startsWith('notification.')
}

export function isToastAction(action: OSAction): action is ToastAction {
  return action.type.startsWith('toast.')
}
