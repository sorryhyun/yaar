import type { OSAction } from '@yaar/shared';
import { extractAppId, DEFAULT_MONITOR_ID } from '@yaar/shared';
import type { ParsedMessage } from './types.js';
import {
  WindowStateRegistry,
  isWindowAction,
  windowCreateAction,
  type WindowAction,
} from '../session/window-state.js';
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
 *
 * The reducer is `WindowStateRegistry` — the same one the live session runs — fed this
 * log's window actions into a throwaway instance, and read back out through
 * `windowCreateAction`. There is no second implementation here any more, which is the
 * point: this file used to hold a hand-written `switch` that was *supposed* to agree with
 * the live one and did not. It handled 9 of the 12 window actions, so `focus`, `minimize`
 * and `restore` fell through with no `default` and a window the user minimized before
 * shutdown came back on screen with nothing anywhere saying a word. Exhaustiveness was
 * added there afterwards, but two reducers can still disagree about what a case *means*;
 * one cannot.
 *
 * Two things restore must supply that a live session gets for free:
 *
 * - **The monitor, explicitly.** `WindowStateRegistry` falls back to the ambient agent
 *   context for a raw id, and a log replay runs inside no agent turn. The monitor is
 *   parsed off the scoped handle instead (see {@link scopedWindowId}), so the placement
 *   comes from the log rather than from whoever happens to be running.
 * - **The handle registered first.** Same reason `restoreFromActions` does it: a scoped id
 *   arriving at `actionKey` *with* a monitor would be registered a second time under it,
 *   minting `0/0/dock` — a key nothing else ever produces.
 */
export function getWindowRestoreActions(messages: ParsedMessage[]): OSAction[] {
  const registry = new WindowStateRegistry();

  for (const msg of messages) {
    // An interaction entry: the user closed a window themselves.
    if (msg.type === 'interaction' && msg.interaction?.startsWith('close:')) {
      applyScoped(registry, {
        type: 'window.close',
        windowId: msg.interaction.slice('close:'.length),
      });
      continue;
    }

    if (msg.type !== 'action' || !msg.action) continue;
    // `handleAction` declines a non-window action on its own; the narrowing here is for
    // `applyScoped`, which has to read a `windowId` off it.
    if (isWindowAction(msg.action)) applyScoped(registry, msg.action);
  }

  return registry.listWindows().map(windowCreateAction);
}

/**
 * Apply one logged window action under its monitor-scoped handle.
 *
 * The id is rewritten, not only re-keyed: the actions this function's registry produces are
 * replayed into the live registry *and* sent to the frontend, and a bare id there is a
 * window on no monitor.
 */
function applyScoped(registry: WindowStateRegistry, action: WindowAction): void {
  const windowId = scopedWindowId(action.windowId);
  const monitorId = windowId.slice(0, windowId.indexOf('/'));
  if (action.type === 'window.create') registry.handleMap.registerHandle(windowId);
  registry.handleAction({ ...action, windowId }, monitorId);
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
