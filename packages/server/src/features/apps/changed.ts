/**
 * An app's files changed on disk — the one sequence that makes everything else notice.
 *
 * Deploy, install, uninstall and git-restore each rewrite an app directory, and each
 * used to follow the write with its own subset of the follow-up: deploy retired windows
 * but install did not, so an updated market app kept running its previous bundle;
 * restore never touched the shortcut; none of them dropped the parsed manifest. The
 * steps are the same for all four, so they live here and the callers state only the one
 * thing that genuinely differs between them — whether running windows are retired.
 */

import { join } from 'path';
import { ServerEventType, type OSAction } from '@yaar/shared';
import { actionEmitter } from '../../session/action-emitter.js';
import { getSessionHub } from '../../session/session-hub.js';
import { getSessionId } from '../../agents/agent-context.js';
import { ensureAppShortcut, removeAppShortcut } from '../../storage/shortcuts.js';
import { APP_ROOTS } from './roots.js';
import { invalidateManifest } from './manifest.js';
import { invalidateAppsCache, listApps } from './discovery.js';
import { retireStaleApp, type RetireResult } from './retire.js';

/**
 * Deliver a desktop action to the calling session.
 *
 * Through the session-scoped `desktop-shortcut` channel rather than `'action'`, because
 * these run from HTTP routes as often as from agent turns, and `'action'` delivers only
 * on behalf of an agent the session knows. Outside any session there is nobody to tell;
 * `emitAction` reports that and drops it.
 */
function emitDesktopAction(action: OSAction): void {
  const sessionId = getSessionId();
  if (sessionId) {
    actionEmitter.emit('desktop-shortcut', {
      sessionId,
      event: { type: ServerEventType.ACTIONS, actions: [action], agentId: 'system' },
    });
  } else {
    actionEmitter.emitAction(action);
  }
}

export interface AppChangedOptions {
  /**
   * Close the calling session's windows of this app, which are still running the
   * bundle that was just replaced or removed (see `retire.ts`).
   *
   * The one step a caller decides. Restore passes false when its recompile failed:
   * the old `dist/` is still what a relaunch would load, so closing the windows would
   * only reopen the same build.
   */
  retire: boolean;
}

/**
 * Tell everything that caches an app that its files changed, then put the result on
 * screen. Call after the write, whether it added, replaced or removed the app.
 *
 * 1. Drop the cached manifest and app listing, so the next read is the new files.
 * 2. Drop the app agent's cached profile in **every** session — it is a cache of disk,
 *    not of the session, and the next turn rebuilds it from the new `protocol.json` and
 *    agent docs. The agent itself (and its conversation) is kept.
 * 3. Optionally retire running windows — see {@link AppChangedOptions.retire}.
 * 4. Bring the app's desktop shortcut in line with the manifest: created if the app
 *    wants one and has none, removed if the app is gone or no longer wants one.
 * 5. `desktop.refreshApps`, last, so the frontend's refetch sees the shortcut change.
 */
export async function notifyAppChanged(
  appId: string,
  { retire }: AppChangedOptions,
): Promise<RetireResult> {
  for (const root of APP_ROOTS) invalidateManifest(join(root, appId));
  invalidateAppsCache();

  for (const session of getSessionHub().all()) session.getPool()?.invalidateAppProfile(appId);

  const retired: RetireResult = retire ? retireStaleApp(appId) : { closed: [] };

  const app = (await listApps()).find((a) => a.id === appId);
  if (app && app.createShortcut !== false) {
    const { shortcut, created } = await ensureAppShortcut(app);
    if (created) emitDesktopAction({ type: 'desktop.createShortcut', shortcut });
  } else if (await removeAppShortcut(appId)) {
    emitDesktopAction({ type: 'desktop.removeShortcut', shortcutId: `app-${appId}` });
  }

  emitDesktopAction({ type: 'desktop.refreshApps' });

  return retired;
}
