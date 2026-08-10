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
 * Close every window of `appId` in the calling session and drop its cached agent profile.
 * Returns the window handles that were closed.
 *
 * Session-scoped, like every other action emitted here: an action is addressed to a
 * session or it is dropped (see `ActionEmitter.resolveSessionId`). Another browser on
 * another session showing the same app keeps its stale window until it relaunches.
 *
 * The caller's own window is spared. An app that deploys *itself* — devtools is the
 * standing example — is mid-request inside that window, and closing it would kill the
 * tool at the moment it succeeded, which reads as a crash rather than a deploy. Its other
 * windows still go, and its profile is still invalidated.
 */
export function retireStaleApp(appId: string): string[] {
  const sessionId = getSessionId();
  const session = sessionId ? getSessionHub().get(sessionId) : undefined;
  if (!session) return [];

  const handleMap = session.windowState.handleMap;

  // The iframe token carries the *raw* window id ("devtools"); the registry keys windows
  // by handle ("0/devtools"). Compare in one spelling or the caller's own window is never
  // recognized and closes itself.
  const callerRaw = getWindowId();
  const callerHandle = callerRaw
    ? (handleMap.resolve(callerRaw, getMonitorId()) ?? callerRaw)
    : undefined;

  const stale = session.windowState
    .listWindows()
    .filter((win) => win.appId === appId && win.id !== callerHandle);

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

  return closed;
}
