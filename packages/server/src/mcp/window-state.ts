/**
 * Window state tracker - maintains server-side state of windows.
 *
 * Tracks windows created via actions and provides query methods
 * for list_windows and view_window tools.
 */

import type { OSAction, ContentUpdateOperation, WindowState } from '@yaar/shared';
import { actionEmitter, type ActionEvent } from './action-emitter.js';

// Re-export WindowState for convenience
export type { WindowState } from '@yaar/shared';

/**
 * Global window state registry.
 * Tracks all windows created through the action emitter.
 */
class WindowStateRegistry {
  private windows: Map<string, WindowState> = new Map();

  constructor() {
    // Subscribe to action events to track window state
    actionEmitter.onAction((event: ActionEvent) => {
      this.handleAction(event.action);
    });
  }

  private handleAction(action: OSAction): void {
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

  /**
   * Get all windows.
   */
  listWindows(): WindowState[] {
    return Array.from(this.windows.values());
  }

  /**
   * Get a specific window by ID.
   */
  getWindow(windowId: string): WindowState | undefined {
    return this.windows.get(windowId);
  }

  /**
   * Check if a window exists.
   */
  hasWindow(windowId: string): boolean {
    return this.windows.has(windowId);
  }

  /**
   * Get window count.
   */
  getWindowCount(): number {
    return this.windows.size;
  }

  /**
   * Restore window state from a list of actions (e.g., from a previous session).
   * Calls handleAction directly, bypassing actionEmitter to avoid side effects.
   */
  restoreFromActions(actions: OSAction[]): void {
    for (const action of actions) {
      this.handleAction(action);
    }
  }
}

/**
 * Singleton instance of the window state registry.
 */
export const windowState = new WindowStateRegistry();
