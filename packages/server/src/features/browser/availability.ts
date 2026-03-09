/**
 * Browser availability check — whether Chrome/Edge was found at startup.
 */

import { getBrowserPool } from '../../lib/browser/index.js';

let _available = false;

/**
 * Whether browser tools were successfully registered (Chrome/Edge was found).
 */
export function isBrowserAvailable(): boolean {
  return _available;
}

/**
 * Probe browser availability. Call once at startup.
 */
export async function probeBrowserAvailability(): Promise<boolean> {
  const pool = getBrowserPool();
  _available = await pool.isAvailable();
  return _available;
}
