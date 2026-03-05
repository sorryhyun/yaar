/**
 * Shared helper to resolve a windowId from a `uri` parameter.
 * Strips any monitor prefix so the raw window ID is returned.
 * Monitor scoping is handled separately by ActionEmitter + WindowStateRegistry.
 */

import { parseWindowUri } from '@yaar/shared';

const MONITOR_PREFIX_RE = /^monitor-[^/]+\//;

/**
 * Resolve a windowId from a uri string.
 * - `yaar://monitor-0/win-id` → `win-id`
 * - `monitor-0/win-id`        → `win-id`
 * - `win-id`                  → `win-id`
 */
export function resolveWindowId(uri: string): string {
  const parsed = parseWindowUri(uri);
  if (parsed) return parsed.windowId;
  // Strip plain monitor prefix (agents sometimes include their own monitor)
  return uri.replace(MONITOR_PREFIX_RE, '');
}
