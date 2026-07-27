import type { OSAction } from '@yaar/shared';
import { applyContentOperation, extractAppId } from '@yaar/shared';
import type { ParsedMessage } from './types.js';
import { generateAppIframeToken } from '../http/iframe-tokens.js';
import { isolatedAppOrigin, isOriginBoundaryActive } from '../http/origin-boundary.js';
import { resolveAppSource } from '../features/apps/roots.js';

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

      case 'window.setContent': {
        const win = windows.get(action.windowId);
        if (win && win.type === 'window.create') {
          win.content = { ...action.content };
        }
        break;
      }

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
 * Re-derive the per-run fields of `window.create` actions that are being replayed
 * rather than freshly emitted — a restored session log, or the snapshot a reconnecting
 * client is handed.
 *
 * Both fields are properties of *this* run, not of the window:
 *
 * - **The iframe token.** A stale token from a session log isn't in the server's token
 *   map, so the app would get a 403 on every verb call.
 * - **The app-origin marks** (`isolateOrigin` / `appOrigin`). These depend on the
 *   boundary currently in force (`http/origin-boundary.ts`), which is a function of the
 *   transport this run chose — so a log written locally must not tell a Tailscale run to
 *   use `127.0.0.1`, and vice versa. Deriving them here also closes a live gap: the
 *   reconnect snapshot rebuilds each action from `WindowStateRegistry`, which never
 *   carried the marks at all, so **every open app window silently lost its origin
 *   isolation on a page refresh.**
 */
export async function refreshRestoredWindowActions(
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
      // Restored ids are scoped handles ("0/dock"), so the monitor is right there in
      // the id — carry it onto the token rather than making the verb route re-derive it.
      const slashIdx = action.windowId.indexOf('/');
      const monitorId = slashIdx > 0 ? action.windowId.slice(0, slashIdx) : undefined;

      // Same rule as features/window/create.ts: only installed (`source:'user'`) apps
      // move to the app origin. Stripped rather than merged, so a mark from another run
      // cannot survive into one whose boundary is off.
      const isolateOrigin =
        isOriginBoundaryActive() && !!appId && resolveAppSource(appId) === 'user';
      const appOrigin = isolateOrigin ? isolatedAppOrigin() : null;

      const { isolateOrigin: _stale, appOrigin: _staleOrigin, ...rest } = action;
      return {
        ...rest,
        iframeToken: await generateAppIframeToken(action.windowId, sessionId, { appId, monitorId }),
        ...(isolateOrigin ? { isolateOrigin: true } : {}),
        ...(appOrigin ? { appOrigin } : {}),
      };
    }),
  );
}
