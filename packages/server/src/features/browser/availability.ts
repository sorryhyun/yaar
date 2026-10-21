/**
 * Browser availability check — whether Chrome/Edge was found at startup.
 */

import { getHeadlessBrowser } from '../../lib/browser/index.js';
import { createLogger } from '../../observability/log.js';

const log = createLogger('Browser');

let _available = false;

/**
 * Whether browser tools were successfully registered (Chrome/Edge was found).
 */
export function isBrowserAvailable(): boolean {
  return _available;
}

/**
 * Probe browser availability. Call once at startup.
 *
 * Says so when there is none. The first anyone heard of a missing Chrome used to be
 * the first `yaar-web` call failing, after an app built on it had already shipped
 * untested (issue #187, item 3).
 */
export async function probeBrowserAvailability(): Promise<boolean> {
  const pool = getHeadlessBrowser();
  _available = await pool.isAvailable();
  if (!_available) {
    log.warn(
      'no Chrome/Chromium found — the Browser app, yaar-web and screenshots will fail until CHROME_PATH names one',
      { checked: 'CHROME_PATH, system install paths, Playwright cache, PATH' },
    );
  }
  return _available;
}
