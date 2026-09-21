/**
 * A second YAAR desktop, parked in a server-side browser, so the user's own client may
 * leave.
 *
 * ## The problem
 *
 * A phone does not keep a backgrounded tab running. Switch to another app and Android
 * first hides YAAR's tab, then freezes it, and every read that is a *round trip into the
 * page* stops answering — `__screenshot` above all, which is rasterized inside the app's
 * own iframe. `session/client-presence.ts` has the measurement: a real Chrome frozen with
 * `Page.setWebLifecycleState` held its WebSocket open for 264s in front of a page that
 * could not execute a line, with the server reporting it connected throughout. That is
 * the state an app-development turn walks into when the user glances at another app: the
 * agent asks to look at the window it just built, and is told the app did not answer.
 *
 * ## Why a second client is the whole fix
 *
 * Nothing about the capture path is per-connection. An action goes out to *every*
 * connection in the session (`BroadcastCenter.publishToSession`) and the first feedback
 * wins (`ActionEmitter.emitActionWithFeedback`); and `clientAwayNote` owes no explanation
 * while any connection in the session is visible, because one that could have answered
 * means the silence was never about a backgrounded tab. So a second desktop that is
 * always visible answers what the phone cannot — with no new mechanism, and nothing for
 * the phone's client to do differently.
 *
 * It joins by simply *connecting*: `SessionHub.attach(null, …)` hands a socket that asked
 * for no particular session the default one, which is the user's.
 *
 * ## Where it runs
 *
 * On the phone, with everything else. Termux keeps running while the user is in another
 * app (given a wake lock), and Chromium there is a normal child of that process tree —
 * so the companion is on the *server* side of the freeze, not the client side. Chromium
 * under Termux needs `--browser-subprocess-path` to spawn renderers at all, which
 * `lib/browser/chrome.ts` already handles; this module only has to ask for a tab.
 *
 * ## The two deliberate choices
 *
 * **`?ui=desktop`.** The phone shell renders one window at a time as a full-screen card,
 * so a capture of any other window would find nothing in the DOM. The companion is never
 * looked at by a person, and the desktop layout is the one that keeps every window
 * mounted.
 *
 * **Pinned against the idle sweep.** Nothing touches this tab between captures, so
 * `cleanupIdle` would collect it precisely when it is about to be needed.
 */

import { getBrowserProvider } from '../../lib/browser/index.js';
import { isYaarOriginUrl } from '../browser/guards.js';
import type { BrowserSession } from '../../lib/browser/index.js';
import { IS_REMOTE } from '../../config.js';
import { getRemoteInfo } from '../../lifecycle.js';
import { createLogger } from '../../observability/log.js';

const log = createLogger('companion');

/** The fixed browserId, so a restart re-finds the tab instead of opening a second one. */
const BROWSER_ID = 'companion-desktop';

/** How often to check the tab is still there and still on the desktop. */
const WATCHDOG_INTERVAL_MS = 60_000;

let session: BrowserSession | null = null;
let watchdog: ReturnType<typeof setInterval> | null = null;
let stopped = false;

/**
 * Whether to park a companion desktop at all.
 *
 * Default-on only on Android, where the client and the server are the same device and so
 * "the user switched apps" is the ordinary case rather than an edge one. Everywhere else
 * the user's own browser window is right there and visible, and a second full desktop —
 * a Chromium process, and a second live iframe for every open app window — would be paid
 * for continuously to solve a problem that is not happening. `YAAR_COMPANION_TAB` forces
 * it either way.
 */
export function wantsCompanionTab(): boolean {
  const flag = process.env.YAAR_COMPANION_TAB;
  if (flag === '1') return true;
  if (flag === '0') return false;
  return process.platform === 'android';
}

/**
 * The URL the companion opens: our own desktop, forced to the layout that mounts every window.
 *
 * `companion=1` is how its socket says what it is (`role=companion`), so the server can
 * answer app commands from the tab the user is looking at and fall back to this one only
 * when that tab cannot run script (`AppWindowCoordinator.rankResponders`).
 */
function companionUrl(port: number): string {
  const base = `http://127.0.0.1:${port}/?ui=desktop&companion=1`;
  // Remote mode gates the desktop on a token even from loopback, the same way the Chrome
  // that `LAUNCH_CHROME=1` opens is handed one rather than asked to paste it.
  const token = IS_REMOTE ? getRemoteInfo()?.token : null;
  return token ? `${base}#remote=${token}` : base;
}

/**
 * Park a companion desktop, if this environment wants one.
 *
 * Never throws and never blocks startup on success: a box with no Chromium simply goes
 * without, exactly as it does today, and says so once. Call after the HTTP server is
 * listening — the tab's first act is to load the desktop from it.
 */
export async function startCompanionTab(port: number): Promise<void> {
  if (!wantsCompanionTab()) return;
  stopped = false;

  const provider = getBrowserProvider();
  if (!(await provider.isAvailable())) {
    log.info('no browser available; the desktop will answer only while its own tab is in front');
    return;
  }

  await openTab(port);
  if (!watchdog) {
    watchdog = setInterval(() => {
      void openTab(port);
    }, WATCHDOG_INTERVAL_MS);
    // A dev server that is otherwise finished should not be held open by this timer.
    watchdog.unref?.();
  }
}

/**
 * Bring the tab up, or put it back.
 *
 * Idempotent on purpose: this is both the initial open and the watchdog tick, because
 * "is it there, and is it still on the desktop?" has the same answer either way. A tab
 * that navigated away (or a Chromium that crashed and came back on a blank page) is
 * steered back rather than replaced, so its browserId — and anything holding it — stays.
 */
async function openTab(port: number): Promise<void> {
  if (stopped) return;
  const provider = getBrowserProvider();
  const url = companionUrl(port);

  try {
    let live = session && provider.getSession(BROWSER_ID) ? session : null;
    if (!live) {
      live = await provider.reviveSession(BROWSER_ID);
    }
    let fresh = false;
    if (!live) {
      const created = await provider.createSession(BROWSER_ID);
      live = created.session;
      fresh = true;
    }

    live.pinned = true;
    session = live;
    const from = live.currentUrl;

    // Origin, not the URL we asked for. The desktop rewrites its own URL (the monitor in
    // the path, a cleared `#remote=`) and Chrome reports `localhost` for the `127.0.0.1`
    // we navigated to, so any string comparison against `url` reads as "it left" on every
    // tick — which would reload the desktop once a minute and drop exactly the state the
    // companion is there to hold. `isYaarOriginUrl` is the existing answer to "is this
    // our own origin", loopback spellings and all.
    if (!isYaarOriginUrl(from)) {
      await live.navigate(url);
      // Two different events wearing one code path: a tab that has just been created has
      // to be sent to the desktop for the first time, and a tab that wandered off (a
      // crash-restart landing on a blank page) has to be sent back. Only the second is
      // worth noticing, so only the second says so.
      if (fresh) log.info('companion desktop opened', { url });
      else log.warn('companion desktop had left; steered back', { from });
    }
  } catch (err) {
    // Not fatal, ever. Without a companion the desktop behaves as it always has: reads
    // that need the page answer while the user's tab is in front, and time out when it
    // is not. The watchdog will try again.
    log.warn('could not park the companion desktop', { err: String(err) });
    session = null;
  }
}

/** Drop the companion on shutdown. */
export async function stopCompanionTab(): Promise<void> {
  stopped = true;
  if (watchdog) {
    clearInterval(watchdog);
    watchdog = null;
  }
  if (!session) return;
  session = null;
  await getBrowserProvider()
    .closeSession(BROWSER_ID)
    .catch(() => {});
}

/** Tests only — the module holds process-wide state. */
export function resetCompanionTabForTest(): void {
  session = null;
  if (watchdog) clearInterval(watchdog);
  watchdog = null;
  stopped = false;
}
