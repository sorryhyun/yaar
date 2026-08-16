/**
 * Retire what is on screen from an app's previous build.
 *
 * Deploying an app replaces its files, and nothing that is already running notices:
 * an open window keeps rendering the bundle its iframe loaded, and the app agent keeps
 * answering from the manifest it was built with. Both then look live while describing a
 * build that no longer exists — the window someone screenshots to confirm a deploy
 * worked is the one showing the code the deploy replaced.
 *
 * So a deploy retires them. The windows close (relaunching from the dock loads the new
 * bundle) and the cached agent profile is dropped (the next turn is built from the new
 * `protocol.json`). Deliberately *not* done: disposing the app agent. The prompt is
 * passed per turn, so invalidating the profile already refreshes it, and disposing would
 * throw away the conversation for no gain.
 */

import { actionEmitter } from '../../session/action-emitter.js';
import { getSessionHub } from '../../session/session-hub.js';
import { getMonitorId, getSessionId, getWindowId } from '../../agents/agent-context.js';
import { createLogger } from '../../observability/log.js';

const log = createLogger('retireStaleApp');

/**
 * What a deploy left behind on screen: the windows it closed, and the one it could not.
 */
export interface RetireResult {
  /** Window handles closed because they were running the previous build. */
  closed: string[];
  /**
   * The deployer's own window, when it is a window of the app just deployed — spared, and
   * therefore still executing the bundle the deploy replaced.
   *
   * Reported rather than merely skipped. Silence here is what made a self-deploy report
   * success while the window kept running the old code: every repo-level check said the
   * fix had shipped, the running app disagreed, and nothing named the discrepancy. A
   * caller that knows its own window is stale can `invoke('yaar://windows/{id}', {action:
   * 'reload'})` when it is ready — after its in-flight command has returned, which is
   * precisely why this cannot be done for it here.
   */
  staleWindow?: string;
}

/**
 * Close every window of `appId` in the calling session and drop its cached agent profile.
 *
 * Session-scoped, like every other action emitted here: an action is addressed to a
 * session or it is dropped (see `ActionEmitter.resolveSessionId`). Another browser on
 * another session showing the same app keeps its stale window until it relaunches.
 *
 * The caller's own window is spared. An app that deploys *itself* — devtools is the
 * standing example — is mid-request inside that window, and closing it would kill the
 * tool at the moment it succeeded, which reads as a crash rather than a deploy. Its other
 * windows still go, its profile is still invalidated, and it is named in
 * {@link RetireResult.staleWindow} so the deploy's answer can say what is still stale.
 */
export function retireStaleApp(appId: string): RetireResult {
  const sessionId = getSessionId();
  const session = sessionId ? getSessionHub().get(sessionId) : undefined;
  if (!session) return { closed: [] };

  const handleMap = session.windowState.handleMap;

  // The iframe token carries the *raw* window id ("devtools"); the registry keys windows
  // by handle ("0/devtools"). Compare in one spelling or the caller's own window is never
  // recognized and closes itself.
  const callerRaw = getWindowId();
  const callerHandle = callerRaw
    ? (handleMap.resolve(callerRaw, getMonitorId()) ?? callerRaw)
    : undefined;

  const ownWindows = session.windowState.listWindows().filter((win) => win.appId === appId);
  const stale = ownWindows.filter((win) => win.id !== callerHandle);
  // Only when the caller is *inside* one of this app's windows. A monitor agent deploying
  // some other app is not stale, and neither is a caller with no window at all.
  const staleWindow = ownWindows.find((win) => win.id === callerHandle)?.id;

  const closed: string[] = [];
  for (const win of stale) {
    try {
      actionEmitter.emitAction(
        { type: 'window.close', windowId: win.id },
        sessionId,
        undefined,
        // The window's own monitor, not the deployer's — they need not be the same one.
        handleMap.getMonitorId(win.id),
      );
      closed.push(win.id);
    } catch (err) {
      // An unscoped window (no monitor on the handle, none in context) cannot be placed,
      // and one of those must not fail a deploy that has already written its files.
      log.warn('could not close window', { windowId: win.id, appId, err });
    }
  }

  session.getPool()?.invalidateAppProfile(appId);

  return { closed, ...(staleWindow ? { staleWindow } : {}) };
}
