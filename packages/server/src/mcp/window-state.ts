/**
 * Window state tracker - maintains server-side state of windows.
 *
 * Tracks windows created via actions and provides query methods
 * for list_windows and view_window tools.
 */

import type { OSAction, ContentUpdateOperation, WindowState, AppProtocolRequest } from '@yaar/shared';

// Re-export WindowState for convenience
export type { WindowState } from '@yaar/shared';

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

  handleAction(action: OSAction): void {
    const now = Date.now();

    switch (action.type) {
      case 'window.create': {
        this.windows.set(action.windowId, {
          id: action.windowId,
          title: action.title,
          bounds: { ...action.bounds },
          content: { ...action.content },
          locked: false,
          createdAt: now,
          updatedAt: now,
        });
        break;
      }

      case 'window.close': {
        this.windows.delete(action.windowId);
        this.appCommands.delete(action.windowId);
        this.onWindowCloseCallback?.(action.windowId);
        break;
      }

      case 'window.setTitle': {
        const win = this.windows.get(action.windowId);
        if (win) {
          win.title = action.title;
          win.updatedAt = now;
        }
        break;
      }

      case 'window.setContent': {
        const win = this.windows.get(action.windowId);
        if (win) {
          win.content = { ...action.content };
          win.updatedAt = now;
        }
        break;
      }

      case 'window.updateContent': {
        const win = this.windows.get(action.windowId);
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
              win.content.data = currentData.slice(0, pos) + (operation.data as string) + currentData.slice(pos);
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
        const win = this.windows.get(action.windowId);
        if (win) {
          win.bounds.x = action.x;
          win.bounds.y = action.y;
          win.updatedAt = now;
        }
        break;
      }

      case 'window.resize': {
        const win = this.windows.get(action.windowId);
        if (win) {
          win.bounds.w = action.w;
          win.bounds.h = action.h;
          win.updatedAt = now;
        }
        break;
      }

      case 'window.lock': {
        const win = this.windows.get(action.windowId);
        if (win) {
          win.locked = true;
          win.lockedBy = action.agentId;
          win.updatedAt = now;
        }
        break;
      }

      case 'window.unlock': {
        const win = this.windows.get(action.windowId);
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
    return this.windows.get(windowId);
  }

  recordAppCommand(windowId: string, request: AppProtocolRequest): void {
    let commands = this.appCommands.get(windowId);
    if (!commands) {
      commands = [];
      this.appCommands.set(windowId, commands);
    }
    commands.push(request);
  }

  getAppCommands(windowId: string): AppProtocolRequest[] {
    return this.appCommands.get(windowId) ?? [];
  }

  setAppProtocol(windowId: string): void {
    const win = this.windows.get(windowId);
    if (win) {
      win.appProtocol = true;
      win.updatedAt = Date.now();
    }
  }

  hasWindow(windowId: string): boolean {
    return this.windows.has(windowId);
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

