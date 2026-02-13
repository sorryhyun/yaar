/**
 * Windows slice - manages windows, z-order, and focus.
 * This is the most complex slice with cross-slice dependencies.
 *
 * Window store keys are scoped by monitorId: "monitor-0/win-storage".
 * This prevents collisions when multiple monitors create windows with the same ID.
 */
import type { SliceCreator, WindowsSlice, DesktopStore, WindowModel } from '../types';
import type { OSAction } from '@yaar/shared';
import { isContentUpdateOperationValid, isWindowContentData } from '@yaar/shared';
import { emptyContentByRenderer, addDebugLogEntry, toWindowKey } from '../helpers';

/**
 * Pure mutation function that applies a window action to an Immer draft.
 * Can be called standalone inside a batched set() or via handleWindowAction.
 */
export function applyWindowAction(state: DesktopStore, action: OSAction): void {
  // Resolve an action's windowId to the correct store key.
  const resolveKey = (rawId: string): string => {
    if (state.windows[rawId]) return rawId;
    const monId =
      (action as { monitorId?: string }).monitorId ?? state.activeMonitorId ?? 'monitor-0';
    return toWindowKey(monId, rawId);
  };

  switch (action.type) {
    case 'window.create': {
      const actionMonitorId = (action as { monitorId?: string }).monitorId;
      const monitorId = actionMonitorId ?? state.activeMonitorId ?? 'monitor-0';
      const key = toWindowKey(monitorId, action.windowId);
      const TITLEBAR_H = 36;
      const TASKBAR_H = 36;
      const vw = typeof globalThis.innerWidth === 'number' ? globalThis.innerWidth : 1280;
      const vh = typeof globalThis.innerHeight === 'number' ? globalThis.innerHeight : 720;
      const b = { ...action.bounds };
      b.x = Math.max(0, Math.min(b.x, vw - 100));
      b.y = Math.max(0, Math.min(b.y, vh - TASKBAR_H - TITLEBAR_H));
      b.w = Math.min(b.w, vw - b.x);
      b.h = Math.min(b.h, vh - TASKBAR_H - b.y);
      const window: WindowModel = {
        id: key,
        title: action.title,
        bounds: b,
        content: { ...action.content },
        minimized: false,
        maximized: false,
        requestId: action.requestId,
        monitorId,
      };
      state.windows[key] = window;
      state.zOrder = state.zOrder.filter((id) => id !== key);
      state.zOrder.push(key);
      state.focusedWindowId = key;
      break;
    }

    case 'window.close': {
      const key = resolveKey(action.windowId);
      const win = state.windows[key];
      const actionAgentId = (action as { agentId?: string }).agentId;
      const reqId = (action as { requestId?: string }).requestId;
      if (win?.locked && win.lockedBy !== actionAgentId) {
        if (reqId) {
          state.pendingFeedback.push({
            requestId: reqId,
            windowId: key,
            renderer: 'lock',
            success: false,
            error: `Window is locked by agent "${win.lockedBy}". Only the locking agent can modify it.`,
          });
        }
        break;
      }
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
      if (state.windows[key]) {
        state.zOrder = state.zOrder.filter((id) => id !== key);
        state.zOrder.push(key);
        state.focusedWindowId = key;
        state.windows[key].minimized = false;
      }
      break;
    }

    case 'window.minimize': {
      const key = resolveKey(action.windowId);
      if (state.windows[key]) {
        state.windows[key].minimized = true;
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
      if (win?.locked && win.lockedBy !== actionAgentId) {
        if (reqId) {
          state.pendingFeedback.push({
            requestId: reqId,
            windowId: key,
            renderer: 'lock',
            success: false,
            error: `Window is locked by agent "${win.lockedBy}". Only the locking agent can modify it.`,
          });
        }
        break;
      }
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
      if (win?.locked && win.lockedBy !== actionAgentId) {
        if (reqId) {
          state.pendingFeedback.push({
            requestId: reqId,
            windowId: key,
            renderer: 'lock',
            success: false,
            error: `Window is currently locked by another agent. Use unlock_window to release the lock before updating.`,
          });
        }
        break;
      }
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
        state.zOrder = state.zOrder.filter((id) => id !== windowId);
        state.zOrder.push(windowId);
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
