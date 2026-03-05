/**
 * Shared helper to resolve a windowId from a `uri` parameter.
 * Accepts both yaar:// URIs and plain window IDs.
 */

import { parseWindowUri } from '@yaar/shared';

/**
 * Resolve a windowId from a uri string.
 * - `yaar://monitor-0/win-id` → extracts `win-id`
 * - `win-id` → passes through as-is
 */
export function resolveWindowId(uri: string): string {
  const parsed = parseWindowUri(uri);
  return parsed ? parsed.windowId : uri;
}
