/**
 * OS Actions DSL - The language the AI uses to control the desktop.
 *
 * When the AI decides to show something, it emits these actions.
 * The frontend applies them to create windows, toasts, and notifications.
 */

import type { ComponentLayout } from './components.js';

// ============ Window Actions ============

export type WindowChangeEvent =
  | 'content'
  | 'interaction'
  | 'close'
  | 'lock'
  | 'unlock'
  | 'move'
  | 'resize'
  | 'title';

export const WINDOW_CHANGE_EVENTS = [
  'content',
  'interaction',
  'close',
  'lock',
  'unlock',
  'move',
  'resize',
  'title',
] as const satisfies readonly WindowChangeEvent[];

export type WindowVariant = 'standard' | 'widget' | 'panel';

export interface WindowBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Default placement policy for a new window.
 *
 * Two independent paths create windows — the server's `handleCreate` (the AI path)
 * and the frontend's desktop-icon click — so these live here rather than being
 * declared twice and drifting. Both cascade from a centered origin: the first
 * window on a monitor lands mid-viewport and each next one steps down-right.
 */
export const WINDOW_PLACEMENT = {
  /** Fallback size when neither the caller nor app.json specifies one. */
  defaultWidth: 640,
  defaultHeight: 480,
  /** Diagonal offset between consecutively opened windows. */
  cascadeStep: 28,
  /** Offset at which the cascade wraps back to the origin. */
  cascadeMax: 280,
  /** Origin used when the monitor's viewport is not known yet. */
  fallbackOrigin: 100,
  /**
   * Bottom viewport space reserved for the command palette:
   * 31 taskbar slot + ~32 monitor row + ~56 input bar + 8 margin.
   * The monitor row sits directly above the glass bar and is present whenever a
   * monitor can be added or switched — i.e. effectively always.
   */
  paletteInset: 127,
} as const;

/**
 * Cascade a new window from a centered origin, clamped to stay fully on screen.
 * `viewport` may be omitted when it hasn't been reported yet, in which case the
 * flat fallback origin is used.
 */
export function cascadeWindowBounds(
  index: number,
  w: number,
  h: number,
  viewport?: { w: number; h: number },
): WindowBounds {
  const P = WINDOW_PLACEMENT;
  const step = (index * P.cascadeStep) % P.cascadeMax;
  if (!viewport) return { x: P.fallbackOrigin + step, y: P.fallbackOrigin + step, w, h };

  const usableH = viewport.h - P.paletteInset;
  const originX = Math.max(0, Math.round((viewport.w - w) / 2) - P.cascadeMax / 2);
  const originY = Math.max(0, Math.round((usableH - h) / 2) - P.cascadeMax / 2);
  return {
    x: Math.max(0, Math.min(originX + step, viewport.w - w)),
    y: Math.max(0, Math.min(originY + step, usableH - h)),
    w,
    h,
  };
}

export interface WindowContent {
  renderer: string; // 'markdown', 'table', 'html', 'text', 'iframe'
  data: unknown;
}

/**
 * Presentation fields shared by a window's persisted state and its creation action — the
 * chrome/placement flags and origin-isolation settings that mean the same thing in both.
 */
export interface WindowPresentation {
  appId?: string;
  variant?: WindowVariant;
  dockEdge?: 'top' | 'bottom';
  frameless?: boolean;
  windowStyle?: Record<string, string | number>;
  minimized?: boolean;
  /**
   * Serve this app's iframe from the isolated app origin, so it is cross-origin to
   * the desktop (app-origin isolation, docs/guides/remote_mode.md). Set by the server
   * only for `source:'user'` apps, and only while an origin boundary is in force.
   */
  isolateOrigin?: boolean;
  /**
   * The exact origin to serve the isolated iframe from, when the client cannot derive
   * it (a remote transport publishing two ports on one hostname). Absent locally,
   * where only the browser knows which port served the desktop and the frontend
   * computes the sibling loopback alias itself.
   */
  appOrigin?: string;
}

/**
 * Window state representation used by both server and frontend.
 */
export interface WindowState extends WindowPresentation {
  id: string;
  title: string;
  bounds: WindowBounds;
  content: WindowContent;
  locked: boolean;
  lockedBy?: string;
  appProtocol?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface WindowCreateAction extends WindowPresentation {
  type: 'window.create';
  windowId: string;
  title: string;
  bounds: WindowBounds;
  content: WindowContent;
  requestId?: string; // For tracking iframe load feedback
  iframeToken?: string; // Token for iframe route restriction
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

export interface WindowCaptureAction {
  type: 'window.capture';
  windowId: string;
  requestId?: string;
}

// ============ Notification Actions ============

export interface NotificationShowAction {
  type: 'notification.show';
  id: string;
  title: string;
  body: string;
  icon?: string;
  duration?: number;
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
  action?: { label: string; eventId: string };
  duration?: number;
}

export interface ToastDismissAction {
  type: 'toast.dismiss';
  id: string;
}

// ============ Dialog Actions ============

export interface PermissionOptions {
  showRememberChoice: boolean;
  toolName: string;
  context?: string;
}

/**
 * One thing being granted, said in the user's terms.
 *
 * The app-install dialog used to put its whole request in `message` as raw grant
 * strings — `yaar://storage/` says *what is granted*, never *what the app can do* — so
 * the one screen where a non-technical user decides how much to trust a stranger's code
 * was the least readable in the product. The server decides what each grant means (it is
 * the side that knows what a URI reaches); the frontend only lays these out, keeping the
 * raw grant visible but demoted so a reader who wants the literal answer still has it.
 */
export interface CapabilityLine {
  /** Single emoji, rendered as the row's icon. */
  icon: string;
  /** The capability in plain language: "Read and write your files". */
  title: string;
  /** Optional qualifier: "Private to this app". */
  detail?: string;
  /** The literal grant this describes (`yaar://storage/`, `yaar-web`), shown demoted. */
  raw?: string;
  /** Broad or privileged — rendered with a warning accent so it reads differently. */
  warn?: boolean;
}

export interface DialogConfirmAction {
  type: 'dialog.confirm';
  id: string;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  permissionOptions?: PermissionOptions;
  /**
   * Structured version of what is being asked for. When present the dialog renders
   * these instead of `message`'s body; `message` stays the fallback (and is what a
   * client too old to know this field still shows).
   */
  capabilities?: CapabilityLine[];
}

/**
 * Take a dialog off the screen without an answer.
 *
 * A confirm dialog has a deadline the user cannot see. When it passes, the server
 * stops listening and the tool that asked is told "denied" — but the dialog itself
 * used to stay up, still offering buttons wired to a request that no longer exists.
 * Whoever clicked one was answering nobody.
 */
export interface DialogCloseAction {
  type: 'dialog.close';
  id: string;
  /** Why it left the screen. `timeout` — the server stopped waiting for an answer. */
  reason?: 'timeout';
}

// ============ User Prompt Actions ============

export interface UserPromptOption {
  value: string;
  label: string;
  description?: string;
}

export interface UserPromptInputField {
  label?: string;
  placeholder?: string;
  type?: 'text' | 'textarea' | 'password';
}

/**
 * Flexible user prompt that covers both "ask" (options) and "request" (text input) use cases.
 *
 * - Options only → radio/checkbox selection (ask)
 * - InputField only → text input (request)
 * - Both → options with an "Other" freeform field
 */
export interface UserPromptShowAction {
  type: 'user.prompt.show';
  id: string;
  title: string;
  message: string;
  options?: UserPromptOption[];
  multiSelect?: boolean;
  inputField?: UserPromptInputField;
  allowDismiss?: boolean;
}

export interface UserPromptDismissAction {
  type: 'user.prompt.dismiss';
  id: string;
}

// ============ Clipboard Actions ============

/**
 * Ask the desktop what is on the system clipboard.
 *
 * The clipboard is the browser's, not the server's, and that is the whole shape of this
 * action. Under `REMOTE=1` the machine running YAAR and the machine holding the clipboard
 * are routinely not the same machine; even locally, only the page has
 * `navigator.clipboard`. So a read is a round trip — this action out, a
 * `CLIPBOARD_RESPONSE` frame back, matched on `id`.
 *
 * Every ceiling below is set by the server and applied by the desktop, so an oversized
 * clipboard is trimmed *before* it crosses the socket rather than after. A 40 MB image
 * pasted from a design tool would otherwise be base64'd onto a WebSocket frame in full,
 * only to be thrown away at the other end.
 */
export interface UserClipboardReadAction {
  type: 'user.clipboard.read';
  id: string;
  /** Ceiling on returned text. Past it the desktop trims and reports the true length. */
  maxChars: number;
  /** Read an image if one is there. False skips the decode/encode entirely. */
  image: boolean;
  /** Longest edge in px an image is downscaled to before encoding. `0` disables downscaling. */
  maxImagePx: number;
  /** Hard ceiling on the encoded image, in bytes. Over it, the read reports `too-large`. */
  maxImageBytes: number;
}

/** Put text on the system clipboard. Answered by the same `CLIPBOARD_RESPONSE` frame. */
export interface UserClipboardWriteAction {
  type: 'user.clipboard.write';
  id: string;
  text: string;
}

// ============ App Actions ============

export interface AppBadgeAction {
  type: 'app.badge';
  appId: string;
  count: number;
}

// ============ Desktop Actions ============

export interface DesktopShortcut {
  id: string;
  label: string;
  icon: string;
  iconType?: 'emoji' | 'image';
  /** URI target: yaar://apps/{id}, yaar://storage/{path}, https://..., or legacy app ID. */
  target: string;
  /** When set, clicking the shortcut executes these actions client-side without AI round-trip. */
  osActions?: OSAction[];
  /** Inline skill instructions sent to AI when clicked. */
  skill?: string;
  /** If set, this shortcut belongs to a folder. */
  folderId?: string;
  createdAt: number;
}

export interface DesktopRefreshAppsAction {
  type: 'desktop.refreshApps';
}

export interface DesktopCreateShortcutAction {
  type: 'desktop.createShortcut';
  shortcut: DesktopShortcut;
}

export interface DesktopRemoveShortcutAction {
  type: 'desktop.removeShortcut';
  shortcutId: string;
}

export interface DesktopUpdateShortcutAction {
  type: 'desktop.updateShortcut';
  shortcutId: string;
  updates: Partial<Omit<DesktopShortcut, 'id' | 'createdAt'>>;
}

export interface DesktopUpdateSettingsAction {
  type: 'desktop.updateSettings';
  settings: {
    userName?: string;
    language?: string;
    wallpaper?: string;
    accentColor?: string;
    iconSize?: 'small' | 'medium' | 'large';
    theme?: 'dark' | 'light';
  };
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
  | WindowUnlockAction
  | WindowCaptureAction;

export type NotificationAction = NotificationShowAction | NotificationDismissAction;

export type ToastAction = ToastShowAction | ToastDismissAction;

export type DialogAction = DialogConfirmAction | DialogCloseAction;

export type UserPromptAction = UserPromptShowAction | UserPromptDismissAction;

export type UserClipboardAction = UserClipboardReadAction | UserClipboardWriteAction;

export type AppAction = AppBadgeAction;

export type DesktopAction =
  | DesktopRefreshAppsAction
  | DesktopCreateShortcutAction
  | DesktopRemoveShortcutAction
  | DesktopUpdateShortcutAction
  | DesktopUpdateSettingsAction;

export type OSAction =
  | WindowAction
  | NotificationAction
  | ToastAction
  | DialogAction
  | UserPromptAction
  | UserClipboardAction
  | AppAction
  | DesktopAction;

// ============ Runtime Validation Helpers ============

export interface TableContentData {
  headers: string[];
  rows: string[][];
}

export interface IframeContentData {
  url: string;
  sandbox?: string;
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

function isTableContentData(value: unknown): value is TableContentData {
  if (!value || typeof value !== 'object') return false;
  const data = value as { headers?: unknown; rows?: unknown };
  return (
    isStringArray(data.headers) &&
    Array.isArray(data.rows) &&
    data.rows.every((row) => isStringArray(row))
  );
}

function isIframeContentData(value: unknown): value is string | IframeContentData {
  if (typeof value === 'string') return true;
  if (!value || typeof value !== 'object') return false;
  const data = value as { url?: unknown; sandbox?: unknown };
  return (
    typeof data.url === 'string' && (data.sandbox === undefined || typeof data.sandbox === 'string')
  );
}

function isComponentLayout(value: unknown): value is ComponentLayout {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as Record<string, unknown>).components)
  );
}

export function isWindowContentData(renderer: string, value: unknown): boolean {
  switch (renderer) {
    case 'markdown':
    case 'html':
    case 'text':
      return typeof value === 'string';
    case 'table':
      return isTableContentData(value);
    case 'component':
      return isComponentLayout(value);
    case 'iframe':
      return isIframeContentData(value);
    default:
      return value !== undefined;
  }
}

export function isContentUpdateOperationValid(
  renderer: string,
  operation: ContentUpdateOperation,
): boolean {
  switch (operation.op) {
    case 'append':
    case 'prepend':
      return ['markdown', 'html', 'text'].includes(renderer) && typeof operation.data === 'string';
    case 'insertAt':
      return (
        ['markdown', 'html', 'text'].includes(renderer) &&
        typeof operation.data === 'string' &&
        Number.isFinite(operation.position)
      );
    case 'replace':
      return isWindowContentData(renderer, operation.data);
    case 'clear':
      return true;
    default:
      return false;
  }
}

/**
 * Apply a content update operation to existing data.
 * Shared between live window state tracking and session restore.
 */
export function applyContentOperation(
  currentData: unknown,
  operation: ContentUpdateOperation,
): unknown {
  switch (operation.op) {
    case 'replace':
      return operation.data;
    case 'append':
      if (typeof currentData === 'string' && typeof operation.data === 'string') {
        return currentData + operation.data;
      }
      return operation.data;
    case 'prepend':
      if (typeof currentData === 'string' && typeof operation.data === 'string') {
        return operation.data + currentData;
      }
      return operation.data;
    case 'insertAt': {
      if (typeof currentData === 'string' && typeof operation.data === 'string') {
        const pos = operation.position;
        return currentData.slice(0, pos) + operation.data + currentData.slice(pos);
      }
      return currentData;
    }
    case 'clear':
      return '';
    default:
      return currentData;
  }
}
