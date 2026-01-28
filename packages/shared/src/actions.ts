/**
 * OS Actions DSL - The language the AI uses to control the desktop.
 *
 * When the AI decides to show something, it emits these actions.
 * The frontend applies them to create windows, toasts, and notifications.
 */

// ============ Window Actions ============

export interface WindowBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WindowContent {
  renderer: string; // 'markdown', 'table', 'html', 'text'
  data: unknown;
}

export interface WindowCreateAction {
  type: 'window.create';
  windowId: string;
  title: string;
  bounds: WindowBounds;
  content: WindowContent;
}

export interface WindowCloseAction {
  type: 'window.close';
  windowId: string;
}

export interface WindowFocusAction {
  type: 'window.focus';
  windowId: string;
}

export interface WindowMinimizeAction {
  type: 'window.minimize';
  windowId: string;
}

export interface WindowMaximizeAction {
  type: 'window.maximize';
  windowId: string;
}

export interface WindowRestoreAction {
  type: 'window.restore';
  windowId: string;
}

export interface WindowMoveAction {
  type: 'window.move';
  windowId: string;
  x: number;
  y: number;
}

export interface WindowResizeAction {
  type: 'window.resize';
  windowId: string;
  w: number;
  h: number;
}

export interface WindowSetTitleAction {
  type: 'window.setTitle';
  windowId: string;
  title: string;
}

export interface WindowSetContentAction {
  type: 'window.setContent';
  windowId: string;
  content: WindowContent;
}

// ============ Notification Actions ============

export interface NotificationShowAction {
  type: 'notification.show';
  id: string;
  title: string;
  body: string;
  icon?: string;
}

export interface NotificationDismissAction {
  type: 'notification.dismiss';
  id: string;
}

// ============ Toast Actions ============

export interface ToastShowAction {
  type: 'toast.show';
  id: string;
  message: string;
  variant?: 'info' | 'success' | 'warning' | 'error';
}

export interface ToastDismissAction {
  type: 'toast.dismiss';
  id: string;
}

// ============ Union Types ============

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
  | WindowSetContentAction;

export type NotificationAction = NotificationShowAction | NotificationDismissAction;

export type ToastAction = ToastShowAction | ToastDismissAction;

export type OSAction = WindowAction | NotificationAction | ToastAction;

// ============ Window Presets ============

export type WindowPreset = 'default' | 'info' | 'alert' | 'document' | 'sidebar' | 'dialog';

export interface WindowPresetConfig {
  width: number;
  height: number;
  x?: number;
  y?: number;
}

export const WINDOW_PRESETS: Record<WindowPreset, WindowPresetConfig> = {
  default: { width: 400, height: 300, x: 100, y: 100 },
  info: { width: 350, height: 200, x: 150, y: 150 },
  alert: { width: 300, height: 150, x: 200, y: 200 },
  document: { width: 600, height: 500, x: 80, y: 60 },
  sidebar: { width: 300, height: 600, x: 20, y: 40 },
  dialog: { width: 400, height: 250, x: 180, y: 180 },
};

// ============ Type Guards ============

export function isWindowAction(action: OSAction): action is WindowAction {
  return action.type.startsWith('window.');
}

export function isNotificationAction(action: OSAction): action is NotificationAction {
  return action.type.startsWith('notification.');
}

export function isToastAction(action: OSAction): action is ToastAction {
  return action.type.startsWith('toast.');
}
