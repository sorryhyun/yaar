import type { OSAction } from '@yaar/shared';
import type { ParsedMessage } from './types.js';

/**
 * Extract window restore actions from parsed messages.
 * Returns the final state of all windows that should still be open.
 */
export function getWindowRestoreActions(messages: ParsedMessage[]): OSAction[] {
  // Track window states by ID
  const windows = new Map<string, OSAction>();

  for (const msg of messages) {
    if (msg.type !== 'action' || !msg.action) continue;
    const action = msg.action;

    switch (action.type) {
      case 'window.create':
        // Store the create action
        windows.set(action.windowId, { ...action });
        break;

      case 'window.close':
        // Remove the window
        windows.delete(action.windowId);
        break;

      case 'window.updateContent': {
        // Apply content update to stored window
        const win = windows.get(action.windowId);
        if (win && win.type === 'window.create') {
          // Apply the operation to the stored content
          const currentData = win.content?.data ?? '';
          const newRenderer = action.renderer ?? win.content?.renderer ?? 'text';

          let newData: unknown = currentData;
          switch (action.operation.op) {
            case 'replace':
              newData = action.operation.data;
              break;
            case 'append':
              if (typeof currentData === 'string' && typeof action.operation.data === 'string') {
                newData = currentData + action.operation.data;
              } else {
                newData = action.operation.data;
              }
              break;
            case 'prepend':
              if (typeof currentData === 'string' && typeof action.operation.data === 'string') {
                newData = action.operation.data + currentData;
              } else {
                newData = action.operation.data;
              }
              break;
            case 'clear':
              newData = '';
              break;
            case 'insertAt':
              if (typeof currentData === 'string' && typeof action.operation.data === 'string') {
                const pos = action.operation.position ?? 0;
                newData = currentData.slice(0, pos) + action.operation.data + currentData.slice(pos);
              }
              break;
          }

          win.content = {
            renderer: newRenderer,
            data: newData,
          };
        }
        break;
      }

      case 'window.setTitle': {
        const win = windows.get(action.windowId);
        if (win && win.type === 'window.create') {
          win.title = action.title;
        }
        break;
      }

      case 'window.move': {
        const win = windows.get(action.windowId);
        if (win && win.type === 'window.create' && win.bounds) {
          win.bounds.x = action.x;
          win.bounds.y = action.y;
        }
        break;
      }

      case 'window.resize': {
        const win = windows.get(action.windowId);
        if (win && win.type === 'window.create' && win.bounds) {
          win.bounds.w = action.w;
          win.bounds.h = action.h;
        }
        break;
      }

      case 'window.lock': {
        const win = windows.get(action.windowId);
        if (win && win.type === 'window.create') {
          // Don't restore locked state - windows should start unlocked
        }
        break;
      }

      case 'window.unlock': {
        // Already handled by not restoring locked state
        break;
      }
    }
  }

  return Array.from(windows.values());
}
