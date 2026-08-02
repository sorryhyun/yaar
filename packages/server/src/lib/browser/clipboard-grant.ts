/**
 * Pre-grants clipboard read to the desktop origin in the user's own Chrome, so
 * `yaar://user/clipboard` never has to make them answer a permission prompt.
 *
 * YAAR launches that Chrome itself (`scripts/dev/start.sh`, `LAUNCH_CHROME=1`) with a
 * DevTools port, which is the only reason this is possible at all — a browser we did
 * not start is not ours to configure.
 *
 * **This is not a launch flag, and it cannot be one.** Chrome has no command line
 * switch for clipboard permission, and the CDP override that does the job
 * (`Browser.grantPermissions`) is scoped to the DevTools *connection* that issued it,
 * not to the profile. Measured against Chrome 149:
 *
 *   baseline                    query=prompt   read=NotAllowedError
 *   after grant                 query=granted  read=OK          ← no prompt, no UI
 *   after page reload           query=granted  read=OK
 *   after another CDP client
 *     connects and disconnects  query=granted  read=OK
 *   after THIS client
 *     disconnects               grant lost, read=NotAllowedError    ← wiped
 *
 * So the open socket *is* the grant: this module holds a browser-level CDP connection
 * for the life of the server and does nothing else with it. The two facts that shape
 * the code below both come out of that table.
 *
 * **It survives other CDP clients, so it does not fight `LocalUserBrowser`.** The
 * override is per-client; the session agent's provider attaching and detaching its own
 * connection to the same Chrome leaves ours alone. The two connections are independent
 * and neither needs to know about the other.
 *
 * **A dropped connection silently loses the grant**, which is what the watchdog is for,
 * and why a reconnect always re-grants rather than assuming an earlier one still
 * stands. What the origin falls back *to* was not stable across measurements — an
 * explicit `stopClipboardGrant()` left it at `prompt` (the user can still grant it
 * themselves), while an abruptly-dropped socket was once observed leaving it `denied`.
 * Do not rely on either; treat a lost connection as "must re-grant".
 *
 * Seeding the profile's `Preferences` file was tried instead and rejected: it makes
 * `permissions.query` report `granted` while reads still fail, and a hand-written
 * `Preferences` broke the CDP path too.
 */

import { CDPClient } from './cdp.js';
import { CHROME_DEBUG_PORT, isClipboardGrantEnabled, DESKTOP_ORIGIN_HOST } from '../../config.js';

/**
 * How often to check on the connection.
 *
 * Chrome is normally *not* up when this starts: `start.sh` backgrounds the browser
 * launch and waits for the server to answer first, so the first several probes are
 * expected to find nothing. 10s keeps the wait after Chrome appears short without
 * making the (permanent, and usually fruitless) poll noticeable on a machine that
 * never runs a debuggable Chrome at all — a refused loopback connect is cheap.
 */
const WATCHDOG_INTERVAL_MS = 10_000;

/**
 * Granted together deliberately. `clipboardSanitizedWrite` is auto-granted by Chrome
 * anyway, so it changes nothing today; naming it means a future tightening of the
 * write path does not quietly turn `user.clipboard.write` into a prompt.
 */
const CLIPBOARD_PERMISSIONS = ['clipboardReadWrite', 'clipboardSanitizedWrite'];

let watchdog: ReturnType<typeof setInterval> | null = null;
let client: CDPClient | null = null;
let grantedOrigin: string | null = null;
/** Log the "no Chrome yet" case once, not every 10 seconds, forever. */
let announcedUnavailable = false;

/** The one origin this may ever grant. See `attempt()` for why it is not a parameter. */
function desktopOrigin(port: number): string {
  return `http://${DESKTOP_ORIGIN_HOST}:${port}`;
}

async function browserWebSocketUrl(debugPort: number): Promise<string | null> {
  try {
    const resp = await fetch(`http://127.0.0.1:${debugPort}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return null;
    const info = (await resp.json()) as { webSocketDebuggerUrl?: string };
    return info.webSocketDebuggerUrl ?? null;
  } catch {
    return null;
  }
}

/**
 * Connect (if needed) and grant.
 *
 * The origin is computed here rather than accepted from a caller on purpose: it must
 * be the *desktop* origin and never `APP_ORIGIN_HOST`. Under app-origin
 * isolation, installed apps are served from the sibling loopback alias precisely so
 * they are cross-origin to the desktop and confined by their `app.json` permissions —
 * granting clipboard read there would hand every installed app the user's clipboard
 * through a door that has no permission check in front of it.
 */
async function attempt(port: number, debugPort: number): Promise<void> {
  if (client && !client.isClosed) return; // still held — nothing to do

  if (client?.isClosed && grantedOrigin) {
    console.warn(
      '[clipboard] Lost the Chrome DevTools connection holding the clipboard grant — reconnecting.',
    );
    grantedOrigin = null;
  }
  client = null;

  const wsUrl = await browserWebSocketUrl(debugPort);
  if (!wsUrl) {
    if (!announcedUnavailable) {
      announcedUnavailable = true;
      console.log(
        `[clipboard] No debuggable Chrome on 127.0.0.1:${debugPort} yet — ` +
          'the desktop will ask for clipboard permission the usual way until one appears.',
      );
    }
    return;
  }

  const origin = desktopOrigin(port);
  try {
    const cdp = await CDPClient.connect(wsUrl);
    await cdp.send('Browser.grantPermissions', {
      origin,
      permissions: CLIPBOARD_PERMISSIONS,
    });
    client = cdp;
    grantedOrigin = origin;
    announcedUnavailable = false;
    console.log(`[clipboard] Granted clipboard access to ${origin} in the local Chrome.`);
  } catch (err) {
    // Never fatal: without it the user just sees the browser's own prompt, which is
    // exactly the behaviour every non-local browser gets anyway.
    client?.close();
    client = null;
    console.warn(
      `[clipboard] Could not pre-grant clipboard access to ${origin}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Start holding the grant. Safe to call when no Chrome exists — it will pick one up
 * whenever it appears, including a Chrome the user restarts mid-session.
 */
export function startClipboardGrant(
  port: number,
  opts: { debugPort?: number; intervalMs?: number } = {},
): void {
  if (!isClipboardGrantEnabled() || watchdog) return;

  // Both overridable for tests only: a suite must not depend on what is listening on
  // the developer's real 9222, nor wait 10s to observe a reconnect.
  const debugPort = opts.debugPort ?? CHROME_DEBUG_PORT;
  const intervalMs = opts.intervalMs ?? WATCHDOG_INTERVAL_MS;

  void attempt(port, debugPort);
  watchdog = setInterval(() => void attempt(port, debugPort), intervalMs);
  // Node/Bun keep the process alive for a pending interval; this one must never be the
  // reason the server does not exit.
  watchdog.unref?.();
}

/** Drop the grant and stop watching. The override dies with the connection. */
export function stopClipboardGrant(): void {
  if (watchdog) {
    clearInterval(watchdog);
    watchdog = null;
  }
  client?.close();
  client = null;
  grantedOrigin = null;
  announcedUnavailable = false;
}

/** Whether the grant is currently held, and for which origin. Diagnostics only. */
export function clipboardGrantStatus(): { held: boolean; origin: string | null } {
  return { held: !!client && !client.isClosed, origin: grantedOrigin };
}
