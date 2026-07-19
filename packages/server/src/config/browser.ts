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
