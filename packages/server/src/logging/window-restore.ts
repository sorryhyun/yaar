import type { OSAction } from '@yaar/shared';
import { applyContentOperation, extractAppId, DEFAULT_MONITOR_ID } from '@yaar/shared';
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
 * A window id from the log, as a monitor-scoped handle.
 *
 * The log is written in both spellings, and a transcript is read long after the code that
 * wrote it: a window the *user* opened was logged bare (`window.create "process-explorer"`)
 * while every interaction on it was logged scoped (`close:0/process-explorer`). Compared
 * as written, the close matched no create — so a restore replayed every window the user
 * had ever opened by hand, including the ones they had closed, and replayed them under a
 * bare key that no later close could address (`WindowStateRegistry.targetKey`). Both
 * halves of that are fixed at the source now; this keeps the transcripts already on disk
 * from restoring wrong.
 *
 * Defaulting a bare id to monitor 0 matches what the frontend does with one, so the two
 * registries agree on the key. It can misplace a hand-opened window from a second monitor
 * in an old log — but that window is unclosable today, and the first session written by
 * the fixed writer records its monitor.
 */
function scopedWindowId(windowId: string): string {
  return windowId.includes('/') ? windowId : `${DEFAULT_MONITOR_ID}/${windowId}`;
}

/**
 * Extract window restore actions from parsed messages.
 * Returns the final state of all windows that should still be open.
 */
export function getWindowRestoreActions(messages: ParsedMessage[]): OSAction[] {
  // Track window states by scoped handle — see scopedWindowId for why not "as written".
  const windows = new Map<string, OSAction>();

  for (const msg of messages) {
    // Handle interaction entries (e.g., user closing a window)
    if (msg.type === 'interaction' && msg.interaction?.startsWith('close:')) {
      const windowId = msg.interaction.slice('close:'.length);
      windows.delete(scopedWindowId(windowId));
      continue;
    }

    if (msg.type !== 'action' || !msg.action) continue;
    const action = msg.action;

    switch (action.type) {
      case 'window.create': {
        // The id is rewritten, not only re-keyed: this action is replayed into both
        // registries, and a bare id there is a window on no monitor.
        const windowId = scopedWindowId(action.windowId);
        windows.set(windowId, { ...action, windowId });
        break;
      }

      case 'window.close':
        // Remove the window
        windows.delete(scopedWindowId(action.windowId));
        break;

      case 'window.setContent': {
        const win = windows.get(scopedWindowId(action.windowId));
        if (win && win.type === 'window.create') {
          win.content = { ...action.content };
        }
        break;
      }

      case 'window.updateContent': {
        const win = windows.get(scopedWindowId(action.windowId));
        if (win && win.type === 'window.create') {
          win.content = {
            renderer: action.renderer ?? win.content?.renderer ?? 'text',
            data: applyContentOperation(win.content?.data ?? '', action.operation),
          };
        }
        break;
      }

      case 'window.setTitle': {
        const win = windows.get(scopedWindowId(action.windowId));
        if (win && win.type === 'window.create') {
          win.title = action.title;
        }
        break;
      }

      case 'window.move': {
        const win = windows.get(scopedWindowId(action.windowId));
        if (win && win.type === 'window.create' && win.bounds) {
          win.bounds.x = action.x;
          win.bounds.y = action.y;
        }
        break;
      }

      case 'window.resize': {
        const win = windows.get(scopedWindowId(action.windowId));
        if (win && win.type === 'window.create' && win.bounds) {
          win.bounds.w = action.w;
          win.bounds.h = action.h;
        }
        break;
      }

      case 'window.lock': {
        const win = windows.get(scopedWindowId(action.windowId));
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
      // The action's own `appId` first. Deriving it from the content *path* alone is a
      // guess that only works for the two shapes below, and a window whose document is
      // storage-served — which is every devtools preview — matches neither: it came back
      // as an anonymous iframe principal, losing `self` resolution and with it the
      // automatic `yaar://apps/self/{storage,db,agents}/` grants. A token is supposed to
      // be the pure carrier of identity; identity did not survive the refresh either.
      const appId =
        action.appId ??
        (typeof data === 'string'
          ? (extractAppId(data) ?? extractAppIdFromPath(data) ?? undefined)
          : undefined);
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
