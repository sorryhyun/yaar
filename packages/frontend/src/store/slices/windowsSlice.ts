/**
 * Windows slice - manages windows, z-order, and focus.
 * This is the most complex slice with cross-slice dependencies.
 *
 * Window store keys are scoped by monitorId: "monitor-0/win-storage".
 * This prevents collisions when multiple monitors create windows with the same ID.
 */
import type { SliceCreator, WindowsSlice, DesktopStore, WindowModel } from '../types';
import type { OSAction, WindowCreateAction } from '@yaar/shared';
import { isContentUpdateOperationValid, isWindowContentData } from '@yaar/shared';
import { emptyContentByRenderer, addDebugLogEntry, toWindowKey } from '../helpers';
import {
  TITLEBAR_HEIGHT,
  TASKBAR_HEIGHT,
  DEFAULT_VIEWPORT_WIDTH,
  DEFAULT_VIEWPORT_HEIGHT,
  MIN_VISIBLE_WINDOW_EDGE,
  DEFAULT_MONITOR_ID,
} from '@/constants/layout';

/**
 * Inserts a window key into zOrder respecting variant layering.
 * Panels are excluded from zOrder entirely (rendered at a fixed position).
 * Widgets stay below standard windows. Standard windows go to the top.
 * Always removes the key first so this is safe to call on focus or re-create.
 */
function insertIntoZOrder(
  state: { zOrder: string[]; windows: Record<string, { variant?: string } | undefined> },
  key: string,
  variant: WindowModel['variant'],
): void {
  if (variant === 'panel') return;
  state.zOrder = state.zOrder.filter((id) => id !== key);
  if (variant === 'widget') {
    const firstStandardIdx = state.zOrder.findIndex((id) => {
      const w = state.windows[id];
      return !w?.variant || w.variant === 'standard';
    });
    if (firstStandardIdx === -1) {
      state.zOrder.push(key);
    } else {
      state.zOrder.splice(firstStandardIdx, 0, key);
    }
  } else {
    state.zOrder.push(key);
  }
}

/**
 * Returns true if the window is locked by a different agent (caller should break).
 * Pushes a failure feedback entry when a requestId is present.
 * Default error message names the locking agent; pass a custom message to override.
 */
function rejectIfLocked(
  state: Pick<DesktopStore, 'pendingFeedback'>,
  win: WindowModel | undefined,
  agentId: string | undefined,
  reqId: string | undefined,
  windowId: string,
  error?: string,
): boolean {
  if (!win?.locked || win.lockedBy === agentId) return false;
  if (reqId) {
    state.pendingFeedback.push({
      requestId: reqId,
      windowId,
      renderer: 'lock',
      success: false,
      error:
        error ??
        `Window is locked by agent "${win.lockedBy}". Only the locking agent can modify it.`,
    });
  }
  return true;
}

/**
 * Pure mutation function that applies a window action to an Immer draft.
 * Can be called standalone inside a batched set() or via handleWindowAction.
 */
export function applyWindowAction(state: DesktopStore, action: OSAction): void {
  // Resolve an action's windowId to the correct store key.
  const resolveKey = (rawId: string): string => {
    if (state.windows[rawId]) return rawId;
    const actionMonitorId = (action as { monitorId?: string }).monitorId;
    if (!actionMonitorId) {
      console.warn(
        `[windowsSlice] OS action "${action.type}" missing monitorId, falling back to activeMonitorId="${state.activeMonitorId}"`,
      );
    }
    const monId = actionMonitorId ?? state.activeMonitorId ?? DEFAULT_MONITOR_ID;
    return toWindowKey(monId, rawId);
  };

  switch (action.type) {
    case 'window.create': {
      const createAction = action as WindowCreateAction;
      const actionMonitorId = (createAction as { monitorId?: string }).monitorId;
      const monitorId = actionMonitorId ?? state.activeMonitorId ?? DEFAULT_MONITOR_ID;
      const key = toWindowKey(monitorId, createAction.windowId);
      const variant = createAction.variant;
      const vw =
        typeof globalThis.innerWidth === 'number' ? globalThis.innerWidth : DEFAULT_VIEWPORT_WIDTH;
      const vh =
        typeof globalThis.innerHeight === 'number'
          ? globalThis.innerHeight
          : DEFAULT_VIEWPORT_HEIGHT;
      const b = { ...createAction.bounds };
      const isStandard = !variant || variant === 'standard';
      // Skip titlebar offset for widget/panel (no titlebar)
      const yOffset = isStandard ? TITLEBAR_HEIGHT : 0;
      b.x = Math.max(0, Math.min(b.x, vw - MIN_VISIBLE_WINDOW_EDGE));
      b.y = Math.max(0, Math.min(b.y, vh - TASKBAR_HEIGHT - yOffset));
      b.w = Math.min(b.w, vw - b.x);
      b.h = Math.min(b.h, vh - TASKBAR_HEIGHT - b.y);
      const window: WindowModel = {
        id: key,
        title: createAction.title,
        bounds: b,
        content: { ...createAction.content },
        minimized: createAction.minimized ?? false,
        maximized: false,
        requestId: createAction.requestId,
        monitorId,
        variant,
        dockEdge: createAction.dockEdge,
        frameless: createAction.frameless,
        windowStyle: createAction.windowStyle,
      };
      state.windows[key] = window;
      insertIntoZOrder(state, key, variant);
      // Only steal focus for non-minimized standard windows
      if (isStandard && !createAction.minimized) {
        state.focusedWindowId = key;
      }
      break;
    }

    case 'window.close': {
      const key = resolveKey(action.windowId);
      const win = state.windows[key];
      const actionAgentId = (action as { agentId?: string }).agentId;
      const reqId = (action as { requestId?: string }).requestId;
      if (rejectIfLocked(state, win, actionAgentId, reqId, key)) break;
      delete state.windows[key];
      delete state.queuedActions[key];
      state.zOrder = state.zOrder.filter((id) => id !== key);
      if (state.focusedWindowId === key) {
        state.focusedWindowId = state.zOrder[state.zOrder.length - 1] ?? null;
      }
      break;
    }

    case 'window.focus': {
      const key = resolveKey(action.windowId);
      const win = state.windows[key];
      if (win) {
        insertIntoZOrder(state, key, win.variant);
        state.focusedWindowId = key;
        win.minimized = false;
      }
      break;
    }

    case 'window.minimize': {
      const key = resolveKey(action.windowId);
      const win = state.windows[key];
      if (win) {
        // Widget/panel: no-op (can't be minimized)
        if (win.variant === 'widget' || win.variant === 'panel') break;
        win.minimized = true;
        if (state.focusedWindowId === key) {
          const visible = state.zOrder.filter((id) => !state.windows[id]?.minimized);
          state.focusedWindowId = visible[visible.length - 1] ?? null;
        }
      }
      break;
    }

    case 'window.maximize': {
      const key = resolveKey(action.windowId);
      const win = state.windows[key];
      if (win && !win.maximized) {
        win.previousBounds = { ...win.bounds };
        win.maximized = true;
      }
      break;
    }

    case 'window.restore': {
      const key = resolveKey(action.windowId);
      const win = state.windows[key];
      if (win) {
        if (win.maximized && win.previousBounds) {
          win.bounds = { ...win.previousBounds };
          win.maximized = false;
        }
        win.minimized = false;
      }
      break;
    }

    case 'window.move': {
      const key = resolveKey(action.windowId);
      const win = state.windows[key];
      if (win) {
        win.bounds.x = action.x;
        win.bounds.y = action.y;
      }
      break;
    }

    case 'window.resize': {
      const key = resolveKey(action.windowId);
      const win = state.windows[key];
      if (win) {
        win.bounds.w = action.w;
        win.bounds.h = action.h;
      }
      break;
    }

    case 'window.setTitle': {
      const key = resolveKey(action.windowId);
      if (state.windows[key]) {
        state.windows[key].title = action.title;
      }
      break;
    }

    case 'window.setContent': {
      const key = resolveKey(action.windowId);
      const win = state.windows[key];
      const actionAgentId = (action as { agentId?: string }).agentId;
      const reqId = (action as { requestId?: string }).requestId;
      if (rejectIfLocked(state, win, actionAgentId, reqId, key)) break;
      if (win) {
        win.content = { ...action.content };
      }
      break;
    }

    case 'window.updateContent': {
      const key = resolveKey(action.windowId);
      const win = state.windows[key];
      const actionAgentId = (action as { agentId?: string }).agentId;
      const reqId = (action as { requestId?: string }).requestId;
      if (
        rejectIfLocked(
          state,
          win,
          actionAgentId,
          reqId,
          key,
          'Window is currently locked by another agent. Use unlock_window to release the lock before updating.',
        )
      )
        break;
      if (win) {
        const targetRenderer = action.renderer ?? win.content.renderer;
        const operation = action.operation;

        const operationValid = isContentUpdateOperationValid(targetRenderer, operation);

        const applyReplace = (data: unknown) => {
          win.content.data = data;
        };

        const applyStringUpdate = (data: string) => {
          const currentData = typeof win.content.data === 'string' ? win.content.data : '';
          switch (operation.op) {
            case 'append':
              win.content.data = currentData + data;
              break;
            case 'prepend':
              win.content.data = data + currentData;
              break;
            case 'insertAt': {
              const pos = operation.position;
              win.content.data = currentData.slice(0, pos) + data + currentData.slice(pos);
              break;
            }
            case 'replace':
              applyReplace(data);
              break;
            case 'clear':
              win.content.data = '';
              break;
          }
        };

        if (operationValid) {
          if (operation.op === 'clear') {
            win.content.data = emptyContentByRenderer(targetRenderer);
          } else if (operation.op === 'replace') {
            applyReplace(operation.data);
          } else if (typeof operation.data === 'string') {
            applyStringUpdate(operation.data);
          }
        } else {
          addDebugLogEntry(state, 'window.updateContent.invalid', {
            windowId: key,
            renderer: targetRenderer,
            operation,
          });
          if ('data' in operation && isWindowContentData(targetRenderer, operation.data)) {
            applyReplace(operation.data);
          }
        }

        if (action.renderer && isWindowContentData(targetRenderer, win.content.data)) {
          win.content.renderer = targetRenderer;
        }
        if (reqId && win.locked) {
          state.pendingFeedback.push({
            requestId: reqId,
            windowId: key,
            renderer: 'lock',
            success: true,
            locked: true,
          });
        }
      }
      break;
    }

    case 'window.lock': {
      const key = resolveKey(action.windowId);
      const win = state.windows[key];
      if (win && !win.locked) {
        win.locked = true;
        win.lockedBy = action.agentId;
      }
      break;
    }

    case 'window.unlock': {
      const key = resolveKey(action.windowId);
      const win = state.windows[key];
      if (win && win.locked && win.lockedBy === action.agentId) {
        win.locked = false;
        win.lockedBy = undefined;
      }
      break;
    }
  }
}

export const createWindowsSlice: SliceCreator<WindowsSlice> = (set, _get) => ({
  windows: {},
  zOrder: [],
  focusedWindowId: null,

  handleWindowAction: (action: OSAction) =>
    set((state) => {
      applyWindowAction(state as DesktopStore, action);
    }),

  userFocusWindow: (windowId) =>
    set((state) => {
      const win = state.windows[windowId];
      if (win) {
        insertIntoZOrder(state, windowId, win.variant);
        state.focusedWindowId = windowId;
        win.minimized = false;
        (state as DesktopStore).pendingInteractions.push({
          type: 'window.focus',
          timestamp: Date.now(),
          windowId,
        });
      }
    }),

  userCloseWindow: (windowId) =>
    set((state) => {
      delete state.windows[windowId];
      delete (state as DesktopStore).queuedActions[windowId];
      state.zOrder = state.zOrder.filter((id) => id !== windowId);
      if (state.focusedWindowId === windowId) {
        state.focusedWindowId = state.zOrder[state.zOrder.length - 1] ?? null;
      }
      (state as DesktopStore).pendingInteractions.push({
        type: 'window.close',
        timestamp: Date.now(),
        windowId,
      });
    }),

  userMoveWindow: (windowId, x, y) =>
    set((state) => {
      const win = state.windows[windowId];
      if (win) {
        win.bounds.x = x;
        win.bounds.y = y;
        win.maximized = false;
      }
    }),

  userResizeWindow: (windowId, w, h, x?, y?) =>
    set((state) => {
      const win = state.windows[windowId];
      if (win) {
        win.bounds.w = w;
        win.bounds.h = h;
        if (x !== undefined) win.bounds.x = x;
        if (y !== undefined) win.bounds.y = y;
        win.maximized = false;
      }
    }),

  userSnapWindow: (windowId, bounds) =>
    set((state) => {
      const win = state.windows[windowId];
      if (win) {
        if (!win.previousBounds) {
          win.previousBounds = { ...win.bounds };
        }
        win.bounds = { ...bounds };
        win.maximized = false;
      }
    }),

  // On drag-end / resize-end: push a consolidated interaction with bounds for immediate send
  queueBoundsUpdate: (windowId) =>
    set((state) => {
      const win = state.windows[windowId];
      if (!win) return;
      // Replace any existing pending bounds interaction for the same window
      const store = state as DesktopStore;
      const idx = store.pendingInteractions.findIndex(
        (i) =>
          (i.type === 'window.move' || i.type === 'window.resize') &&
          i.windowId === windowId &&
          i.bounds,
      );
      const interaction = {
        type: 'window.move' as const,
        timestamp: Date.now(),
        windowId,
        bounds: {
          x: win.bounds.x,
          y: win.bounds.y,
          w: win.bounds.w,
          h: win.bounds.h,
        },
      };
      if (idx >= 0) {
        store.pendingInteractions[idx] = interaction;
      } else {
        store.pendingInteractions.push(interaction);
      }
    }),
});
