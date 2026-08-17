/**
 * Browser-related configuration.
 */

import { join } from 'path';
import { getEnvInt } from './env.js';
import { getStorageDir } from './paths.js';

/**
 * DevTools debug port of the user's own Chrome, used by `LocalUserBrowser`
 * (the local-browser BrowserProvider). The user launches Chrome with
 * `--remote-debugging-port=<port>`; YAAR attaches to it over CDP instead of
 * spawning a private headless Chrome.
 */
export const CHROME_DEBUG_PORT = getEnvInt('CHROME_DEBUG_PORT', 9222);

/**
 * Whether to pre-grant clipboard access to the desktop origin in that Chrome, so the
 * user is never shown a clipboard permission prompt (`lib/browser/clipboard-grant.ts`).
 *
 * On by default, and `YAAR_CLIPBOARD_GRANT=0` turns it off. The opt-out exists because
 * this is a real loosening: with it on, any agent turn can read whatever the user last
 * copied — passwords included — with no prompt and no visible indication. The browser
 * prompt is otherwise the only consent gate on that path. Turning it off costs one
 * click, once per Chrome profile.
 *
 * Only ever affects a local Chrome YAAR can reach over CDP; every other browser (remote
 * mode on a phone, a hand-opened tab, Firefox) prompts regardless.
 */
export function isClipboardGrantEnabled(): boolean {
  return process.env.YAAR_CLIPBOARD_GRANT !== '0';
}

/**
 * Everything the headless sandbox browser keeps between runs — the Chrome profile
 * and the record of which named sessions existed and where they were.
 *
 * Under `storage/` rather than `tmpdir()` because that is the difference between
 * "a browser" and "a process": a profile in `/tmp` loses every login the moment
 * YAAR exits, and a session record in memory loses the page the human was on the
 * moment the desktop reloads. Reads `getStorageDir()` per call rather than the
 * `STORAGE_DIR` constant so a test's `YAAR_STORAGE` override is honoured even when
 * this module was evaluated first.
 */
export function getBrowserStateDir(): string {
  return process.env.YAAR_BROWSER_STATE_DIR || join(getStorageDir(), '.browser');
}

/**
 * The sandbox Chrome's `--user-data-dir`.
 *
 * Persistent by default: cookies, `localStorage` and logins survive a restart, which
 * is the whole point of work item 4's "so logins survive". Still a *sandbox* — it is
 * not the user's real Chrome profile, which only `LocalUserBrowser` ever touches.
 *
 * `YAAR_BROWSER_EPHEMERAL=1` goes back to the pre-P1 behaviour (a `mkdtemp` dir wiped
 * on shutdown) for anyone who wants the sandbox to forget, and for the one case where
 * persistence is actively wrong: two YAARs sharing a checkout would otherwise fight
 * over the same profile lock.
 */
export function isEphemeralBrowserProfile(): boolean {
  return process.env.YAAR_BROWSER_EPHEMERAL === '1';
}

/**
 * Minutes a browser session may sit untouched before the idle sweep closes it.
 *
 * `0` disables the sweep. A session with a live viewer attached (someone is looking
 * at the canvas) is exempt regardless — "idle" means nobody is watching, not "nobody
 * typed recently", and reading a long page must not cost you the tab.
 */
export function getBrowserIdleMinutes(): number {
  return getEnvInt('YAAR_BROWSER_IDLE_MINUTES', 5);
}
