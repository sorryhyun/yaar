/**
 * Which window an app-directed call should reach — and opening one when there is none.
 *
 * Two doors ask this question about the same app on the same monitor: cross-app control
 * (`mcp/app-agent`'s `query`/`command` with an `appId`) and `direct_message` to
 * `app:{id}`. They used to answer it differently — control walked the pool, then every
 * window on the monitor, then opened one; messaging asked the pool alone and refused if
 * it came back empty. So the same grant, the same app and the same monitor produced
 * "driven" through one door and "has no open window" through the other, and an app window
 * the pool had never recorded (opened by the user, never messaged) was invisible to
 * messaging while control found it. One resolver, one answer.
 *
 * **Monitor-scoped, always.** Monitor N's copy of an app is not monitor M's to drive or
 * message; a caller that finds nothing on its own monitor opens its own copy rather than
 * reaching across. This mirrors `getActiveAppWindow`'s scoping, which exists for the same
 * reason.
 *
 * **Launching is the caller's decision, not this module's.** `launch` is passed in
 * because the two doors gate it differently: control is gated by `controls` (bundled-only
 * authority to drive another app), while messaging lets session/monitor principals launch
 * freely and an app principal only for a target its own `controls` names —
 * `"messaging": "all"` buys a conversation with a running app, not the authority to put
 * one on the user's desktop.
 */

import type { LiveSession } from '../../session/live-session.js';
import { listApps } from '../apps/discovery.js';
import { handleCreate } from './create.js';

export type AppWindowResolution =
  | { found: true; windowId: string; launched: boolean }
  /** `attemptedLaunch` separates "we did not try" from "we tried and it failed". */
  | { found: false; attemptedLaunch: boolean };

/**
 * Open a window for an app that has none on this monitor.
 *
 * The id is left to `handleCreate` to derive and allocate rather than pinned to the
 * appId. A *named* id that is already live is refused outright — naming one is a claim
 * about which window you mean — while a derived one steps to `{appId}-2`. Ids are
 * derived from the appId, so anything else already holding this app's id on this
 * monitor (a plain window whose title slugged the same way) turned auto-open into a hard
 * `could not be opened to control`, for a target that was not open at all.
 *
 * Returns the id the create actually minted, which for that reason is not knowable up
 * front. `background` opens it minimized — the iframe still mounts and loads (the
 * frontend hides minimized windows rather than unmounting them), so an app driven purely
 * for compute need not take the user's screen.
 */
async function launchAppWindow(appId: string, background?: boolean): Promise<string | undefined> {
  const app = (await listApps()).find((a) => a.id === appId);
  if (!app) return undefined;
  const result = await handleCreate('', {
    title: app.name ?? appId,
    renderer: 'iframe',
    content: `yaar://apps/${appId}`,
    appId,
    ...(background ? { minimized: true } : {}),
  });
  if (result.isError) return undefined;
  const minted = result.structuredContent?.windowId;
  return typeof minted === 'string' ? minted : undefined;
}

/**
 * Resolve a live window of `appId` on `monitorId`: the app agent's most recently active
 * one, else any window of that app on the monitor, else — when `launch` is set — a fresh
 * one, blocking on the iframe's load so the caller's next call has something to talk to.
 */
export async function resolveAppWindowOnMonitor(
  session: LiveSession,
  monitorId: string,
  appId: string,
  opts: { launch: boolean; background?: boolean },
): Promise<AppWindowResolution> {
  const existing =
    session.getPool()?.getActiveAppWindow(monitorId, appId) ??
    session.windowState
      .listWindows()
      .find((w) => w.appId === appId && session.windowState.getMonitorForWindow(w.id) === monitorId)
      ?.id;
  if (existing) return { found: true, windowId: existing, launched: false };

  if (!opts.launch) return { found: false, attemptedLaunch: false };

  const windowId = await launchAppWindow(appId, opts.background);
  return windowId
    ? { found: true, windowId, launched: true }
    : { found: false, attemptedLaunch: true };
}
