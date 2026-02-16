/**
 * Window state tracker - maintains server-side state of windows.
 *
 * Tracks windows created via actions and provides query methods
 * for list_windows and view_window tools.
 *
 * Uses monitorId-scoped keys internally to prevent collision when
 * multiple monitors create windows with the same raw ID.
 * Key format: "monitorId/rawWindowId" (e.g., "monitor-0/win-storage").
 */

import type {
  OSAction,
  ContentUpdateOperation,
  WindowState,
  AppProtocolRequest,
} from '@yaar/shared';

// Re-export WindowState for convenience
export type { WindowState } from '@yaar/shared';

/**
 * Build a scoped key from monitorId and rawId.
 */
function scopedKey(monitorId: string, rawId: string): string {
  return `${monitorId}/${rawId}`;
}

/**
 * Window state registry for one connection/session.
 */
export class WindowStateRegistry {
  private windows: Map<string, WindowState> = new Map();
  private appCommands: Map<string, AppProtocolRequest[]> = new Map();
  private onWindowCloseCallback?: (windowId: string) => void;

  /**
   * Set a callback to be invoked when a window is closed.
   * Used to invalidate reload cache entries that depend on the closed window.
   */
  setOnWindowClose(cb: (windowId: string) => void): void {
    this.onWindowCloseCallback = cb;
  }

  /**
   * Resolve a windowId to its internal map key.
   * Tries exact match first, then scans for a key ending with /rawId.
   * Returns the resolved key and the stored WindowState, or undefined.
   */
  private resolve(windowId: string): [string, WindowState] | undefined {
    // 1. Exact match (scoped or legacy raw key)
    const exact = this.windows.get(windowId);
    if (exact) return [windowId, exact];

    // 2. Scan for suffix match — e.g., looking up "win-storage" matches "monitor-0/win-storage"
    const suffix = `/${windowId}`;
    for (const [key, state] of this.windows) {
      if (key.endsWith(suffix)) return [key, state];
    }

    return undefined;
  }

  /**
   * Determine the internal key for a given action windowId + monitorId.
   */
  private actionKey(rawId: string, monitorId?: string): string {
    if (monitorId) return scopedKey(monitorId, rawId);
    // Backward compat: try to find an existing scoped key for this raw ID
    const resolved = this.resolve(rawId);
    return resolved ? resolved[0] : rawId;
  }

  handleAction(action: OSAction, monitorId?: string): void {
    const now = Date.now();

    switch (action.type) {
      case 'window.create': {
        const key = monitorId ? scopedKey(monitorId, action.windowId) : action.windowId;
        this.windows.set(key, {
          id: key,
          title: action.title,
          bounds: { ...action.bounds },
          content: { ...action.content },
          locked: false,
          variant: action.variant,
          dockEdge: action.dockEdge,
          frameless: action.frameless,
          windowStyle: action.windowStyle,
          createdAt: now,
          updatedAt: now,
        });
        break;
      }

      case 'window.close': {
        const key = this.actionKey(action.windowId, monitorId);
        this.windows.delete(key);
        this.appCommands.delete(key);
        this.onWindowCloseCallback?.(key);
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
          const currentData = (win.content.data as string) ?? '';
          const operation = action.operation as ContentUpdateOperation;

          switch (operation.op) {
            case 'append':
              win.content.data = currentData + (operation.data as string);
              break;
            case 'prepend':
              win.content.data = (operation.data as string) + currentData;
              break;
            case 'replace':
              win.content.data = operation.data;
              break;
            case 'insertAt': {
              const pos = operation.position;
              win.content.data =
                currentData.slice(0, pos) + (operation.data as string) + currentData.slice(pos);
              break;
            }
            case 'clear':
              win.content.data = '';
              break;
          }

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

  clear(): void {
    this.windows.clear();
    this.appCommands.clear();
  }

  getWindowCount(): number {
    return this.windows.size;
  }

  restoreFromActions(actions: OSAction[]): void {
    for (const action of actions) {
      this.handleAction(action);
    }
  }
}
