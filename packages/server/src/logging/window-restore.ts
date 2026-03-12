import type { OSAction } from '@yaar/shared';
import { applyContentOperation, extractAppId } from '@yaar/shared';
import type { ParsedMessage } from './types.js';
import { generateIframeToken } from '../http/iframe-tokens.js';
import { getAppMeta } from '../features/apps/discovery.js';

/** Extract appId from resolved paths like /api/apps/{appId}/... */
function extractAppIdFromPath(path: string): string | null {
  const match = path.match(/^\/api\/apps\/([^/]+)\//);
  return match ? match[1] : null;
}

/**
 * Extract window restore actions from parsed messages.
 * Returns the final state of all windows that should still be open.
 */
export function getWindowRestoreActions(messages: ParsedMessage[]): OSAction[] {
  // Track window states by ID
  const windows = new Map<string, OSAction>();

  for (const msg of messages) {
    // Handle interaction entries (e.g., user closing a window)
    if (msg.type === 'interaction' && msg.interaction?.startsWith('close:')) {
      const windowId = msg.interaction.slice('close:'.length);
      windows.delete(windowId);
      continue;
    }

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
        const win = windows.get(action.windowId);
        if (win && win.type === 'window.create') {
          win.content = {
            renderer: action.renderer ?? win.content?.renderer ?? 'text',
            data: applyContentOperation(win.content?.data ?? '', action.operation),
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

/**
 * Generate fresh iframe tokens for restored window.create actions.
 * Stale tokens from session logs won't be in the server's token map,
 * so iframe apps would get 403 on every verb call without this.
 */
export async function refreshIframeTokens(
  actions: OSAction[],
  sessionId: string,
): Promise<OSAction[]> {
  return Promise.all(
    actions.map(async (action) => {
      if (action.type !== 'window.create' || action.content?.renderer !== 'iframe') return action;
      const data = action.content.data;
      const appId =
        typeof data === 'string'
          ? (extractAppId(data) ?? extractAppIdFromPath(data) ?? undefined)
          : undefined;
      const appMeta = appId ? await getAppMeta(appId) : null;
      return {
        ...action,
        iframeToken: generateIframeToken(action.windowId, sessionId, appId, appMeta?.permissions),
      };
    }),
  );
}
