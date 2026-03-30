/**
 * Window state tracker - maintains server-side state of windows.
 *
 * Tracks windows created via actions and provides query methods
 * for list_windows and view_window tools.
 *
 * Delegates handle creation/resolution to WindowHandleMap — this class
 * never constructs composite keys directly.
 */

import type { OSAction, WindowState, AppProtocolRequest } from '@yaar/shared';
import { applyContentOperation } from '@yaar/shared';
import { WindowHandleMap } from './window-handle-map.js';

// Re-export WindowState for convenience
export type { WindowState } from '@yaar/shared';

/**
 * Window state registry for one connection/session.
 */
export class WindowStateRegistry {
  private windows: Map<string, WindowState> = new Map();
  private appCommands: Map<string, AppProtocolRequest[]> = new Map();
  private onWindowCloseCallback?: (windowId: string, appId?: string) => void;

  readonly handleMap: WindowHandleMap;

  constructor(handleMap?: WindowHandleMap) {
    this.handleMap = handleMap ?? new WindowHandleMap();
  }

  /**
   * Set a callback to be invoked when a window is closed.
   * Used to invalidate reload cache entries that depend on the closed window.
   */
  setOnWindowClose(cb: (windowId: string, appId?: string) => void): void {
    this.onWindowCloseCallback = cb;
  }

  /**
   * Resolve a windowId (raw or handle) to its internal map key.
   * Returns the resolved key and the stored WindowState, or undefined.
   */
  private resolve(windowId: string): [string, WindowState] | undefined {
    // 1. Exact match (handle or legacy raw key)
    const exact = this.windows.get(windowId);
    if (exact) return [windowId, exact];

    // 2. Resolve via handle map (raw ID → handle)
    const handle = this.handleMap.resolve(windowId);
    if (handle) {
      const state = this.windows.get(handle);
      if (state) return [handle, state];
    }

    return undefined;
  }

  /**
   * Determine the internal key for a given action windowId + monitorId.
   */
  private actionKey(rawId: string, monitorId?: string): string {
    if (monitorId) return this.handleMap.register(rawId, monitorId);
    // Backward compat: try to find an existing handle for this raw ID
    const resolved = this.resolve(rawId);
    return resolved ? resolved[0] : rawId;
  }

  handleAction(action: OSAction, monitorId?: string): void {
    const now = Date.now();

    switch (action.type) {
      case 'window.create': {
        const key = this.actionKey(action.windowId, monitorId);
        this.windows.set(key, {
          id: key,
          title: action.title,
          bounds: { ...action.bounds },
          content: { ...action.content },
          locked: false,
          ...(action.appId ? { appId: action.appId } : {}),
          variant: action.variant,
          dockEdge: action.dockEdge,
          frameless: action.frameless,
          windowStyle: action.windowStyle,
          minimized: action.minimized,
          createdAt: now,
          updatedAt: now,
        });
        break;
      }

      case 'window.close': {
        const key = this.actionKey(action.windowId, monitorId);
        const appId = this.windows.get(key)?.appId;
        this.windows.delete(key);
        this.appCommands.delete(key);
        this.handleMap.remove(key);
        this.onWindowCloseCallback?.(key, appId);
        break;
      }

      case 'window.setTitle': {
        const key = this.actionKey(action.windowId, monitorId);
        const win = this.windows.get(key);
        if (win) {
          win.title = action.title;
          win.updatedAt = now;
        }
        break;
      }

      case 'window.setContent': {
        const key = this.actionKey(action.windowId, monitorId);
        const win = this.windows.get(key);
        if (win) {
          win.content = { ...action.content };
          win.updatedAt = now;
        }
        break;
      }

      case 'window.updateContent': {
        const key = this.actionKey(action.windowId, monitorId);
        const win = this.windows.get(key);
        if (win) {
          win.content.data = applyContentOperation(win.content.data ?? '', action.operation);
          if (action.renderer) {
            win.content.renderer = action.renderer;
          }
          win.updatedAt = now;
        }
        break;
      }

      case 'window.move': {
        const key = this.actionKey(action.windowId, monitorId);
        const win = this.windows.get(key);
        if (win) {
          win.bounds.x = action.x;
          win.bounds.y = action.y;
          win.updatedAt = now;
        }
        break;
      }

      case 'window.resize': {
        const key = this.actionKey(action.windowId, monitorId);
        const win = this.windows.get(key);
        if (win) {
          win.bounds.w = action.w;
          win.bounds.h = action.h;
          win.updatedAt = now;
        }
        break;
      }

      case 'window.lock': {
        const key = this.actionKey(action.windowId, monitorId);
        const win = this.windows.get(key);
        if (win) {
          win.locked = true;
          win.lockedBy = action.agentId;
          win.updatedAt = now;
        }
        break;
      }

      case 'window.unlock': {
        const key = this.actionKey(action.windowId, monitorId);
        const win = this.windows.get(key);
        if (win) {
          win.locked = false;
          win.lockedBy = undefined;
          win.updatedAt = now;
        }
        break;
      }
    }
  }

  listWindows(): WindowState[] {
    return Array.from(this.windows.values());
  }

  getWindow(windowId: string): WindowState | undefined {
    const resolved = this.resolve(windowId);
    return resolved ? resolved[1] : undefined;
  }

  recordAppCommand(windowId: string, request: AppProtocolRequest): void {
    const resolved = this.resolve(windowId);
    const key = resolved ? resolved[0] : windowId;
    let commands = this.appCommands.get(key);
    if (!commands) {
      commands = [];
      this.appCommands.set(key, commands);
    }
    commands.push(request);
  }

  getAppCommands(windowId: string): AppProtocolRequest[] {
    const resolved = this.resolve(windowId);
    const key = resolved ? resolved[0] : windowId;
    return this.appCommands.get(key) ?? [];
  }

  setAppProtocol(windowId: string): void {
    const resolved = this.resolve(windowId);
    if (resolved) {
      resolved[1].appProtocol = true;
      resolved[1].updatedAt = Date.now();
    }
  }

  hasWindow(windowId: string): boolean {
    return this.resolve(windowId) !== undefined;
  }

  /**
   * Check if a window is locked by a different agent.
   * Returns the locking agent's ID if locked by someone else, or null if not locked / locked by the same agent.
   */
  isLockedByOther(windowId: string, agentId?: string): string | null {
    const resolved = this.resolve(windowId);
    if (!resolved) return null;
    const win = resolved[1];
    if (!win.locked) return null;
    if (agentId && win.lockedBy === agentId) return null;
    return win.lockedBy ?? 'unknown';
  }

  getAppIdForWindow(windowId: string): string | undefined {
    const resolved = this.resolve(windowId);
    return resolved ? resolved[1].appId : undefined;
  }

  isAppProtocolWindow(windowId: string): boolean {
    const resolved = this.resolve(windowId);
    if (!resolved) return false;
    return resolved[1].appProtocol === true && !!resolved[1].appId;
  }

  clear(): void {
    this.windows.clear();
    this.appCommands.clear();
    this.handleMap.clear();
  }

  getWindowCount(): number {
    return this.windows.size;
  }

  restoreFromActions(actions: OSAction[]): void {
    for (const action of actions) {
      this.handleAction(action);
      // Restored actions have scoped windowIds (e.g., "0/dock").
      // Register the handle mapping so raw-ID lookups work for verb tools.
      const windowId = (action as { windowId?: string }).windowId;
      if (windowId) {
        this.handleMap.registerHandle(windowId);
      }
    }
  }
}
