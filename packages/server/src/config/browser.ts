/**
 * Browser-related configuration.
 */

import { getEnvInt } from './env.js';

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
