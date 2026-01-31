/**
 * OS Actions DSL - The language the AI uses to control the desktop.
 *
 * When the AI decides to show something, it emits these actions.
 * The frontend applies them to create windows, toasts, and notifications.
 */

import type { ComponentNode } from './components'
import { isComponent } from './components'

// ============ Window Actions ============

export interface WindowBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WindowContent {
  renderer: string; // 'markdown', 'table', 'html', 'text', 'iframe'
  data: unknown;
}

/**
 * Window state representation used by both server and frontend.
 */
export interface WindowState {
  id: string;
  title: string;
  bounds: WindowBounds;
  content: WindowContent;
  locked: boolean;
  lockedBy?: string;
  createdAt: number;
  updatedAt: number;
}

export interface WindowCreateAction {
  type: 'window.create';
  windowId: string;
  title: string;
  bounds: WindowBounds;
  content: WindowContent;
  requestId?: string; // For tracking iframe load feedback
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

// ============ Content Update Operations ============

export type ContentUpdateOperation =
  | { op: 'append'; data: unknown }
  | { op: 'prepend'; data: unknown }
  | { op: 'replace'; data: unknown }
  | { op: 'insertAt'; position: number; data: unknown }
  | { op: 'clear' };

export interface WindowUpdateContentAction {
  type: 'window.updateContent';
  windowId: string;
  operation: ContentUpdateOperation;
  renderer?: string; // Optional: change renderer type
}

export interface WindowLockAction {
  type: 'window.lock';
  windowId: string;
  agentId: string;
}

export interface WindowUnlockAction {
  type: 'window.unlock';
  windowId: string;
  agentId: string;
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

// ============ Dialog Actions ============

export interface DialogConfirmAction {
  type: 'dialog.confirm';
  id: string;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
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
  | WindowSetContentAction
  | WindowUpdateContentAction
  | WindowLockAction
  | WindowUnlockAction;

export type NotificationAction = NotificationShowAction | NotificationDismissAction;

export type ToastAction = ToastShowAction | ToastDismissAction;

export type DialogAction = DialogConfirmAction;

export type OSAction = WindowAction | NotificationAction | ToastAction | DialogAction;

// ============ Window Presets ============

export type WindowPreset = 'default' | 'info' | 'alert' | 'document' | 'sidebar' | 'dialog';

export interface WindowPresetConfig {
  width: number;
  height: number;
  x?: number;
  y?: number;
}

export const WINDOW_PRESETS: Record<WindowPreset, WindowPresetConfig> = {
  default: { width: 500, height: 400, x: 100, y: 100 },
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

export function isDialogAction(action: OSAction): action is DialogAction {
  return action.type.startsWith('dialog.');
}

// ============ Runtime Validation Helpers ============

export interface TableContentData {
  headers: string[];
  rows: string[][];
}

export interface IframeContentData {
  url: string;
  sandbox?: string;
}

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

export function isTableContentData(value: unknown): value is TableContentData {
  if (!value || typeof value !== 'object') return false
  const data = value as { headers?: unknown; rows?: unknown }
  return isStringArray(data.headers) && Array.isArray(data.rows) && data.rows.every((row) => isStringArray(row))
}

export function isIframeContentData(value: unknown): value is string | IframeContentData {
  if (typeof value === 'string') return true
  if (!value || typeof value !== 'object') return false
  const data = value as { url?: unknown; sandbox?: unknown }
  return typeof data.url === 'string' && (data.sandbox === undefined || typeof data.sandbox === 'string')
}

export function isComponentNode(value: unknown): value is ComponentNode {
  return typeof value === 'string' || (typeof value === 'object' && value !== null && isComponent(value as ComponentNode))
}

export function isWindowContentData(renderer: string, value: unknown): boolean {
  switch (renderer) {
    case 'markdown':
    case 'html':
    case 'text':
      return typeof value === 'string'
    case 'table':
      return isTableContentData(value)
    case 'component':
      return isComponentNode(value)
    case 'iframe':
      return isIframeContentData(value)
    default:
      return value !== undefined
  }
}

export function isContentUpdateOperationValid(renderer: string, operation: ContentUpdateOperation): boolean {
  switch (operation.op) {
    case 'append':
    case 'prepend':
      return ['markdown', 'html', 'text'].includes(renderer) && typeof operation.data === 'string'
    case 'insertAt':
      return ['markdown', 'html', 'text'].includes(renderer)
        && typeof operation.data === 'string'
        && Number.isFinite(operation.position)
    case 'replace':
      return isWindowContentData(renderer, operation.data)
    case 'clear':
      return true
    default:
      return false
  }
}
