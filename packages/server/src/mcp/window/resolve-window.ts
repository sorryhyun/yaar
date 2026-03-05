/**
 * Shared helper to resolve a windowId from a `uri` parameter.
 * Strips any monitor prefix so the raw window ID is returned.
 * Monitor scoping is handled separately by ActionEmitter + WindowStateRegistry.
 */

import { parseWindowUri, parseYaarUri } from '@yaar/shared';

const MONITOR_PREFIX_RE = /^monitor-[^/]+\//;

/**
 * Resolve a windowId from a uri string.
 * - `yaar://monitor-0/win-id` → `win-id`
 * - `yaar://apps/word-lite`   → `word-lite`  (content URI → use app ID)
 * - `yaar://storage/doc.md`   → `doc.md`     (content URI → use path)
 * - `monitor-0/win-id`        → `win-id`
 * - `win-id`                  → `win-id`
 */
export function resolveWindowId(uri: string): string {
  const parsed = parseWindowUri(uri);
  if (parsed) return parsed.windowId;
  // Handle content URIs (yaar://apps/..., yaar://storage/..., yaar://sandbox/...)
  const content = parseYaarUri(uri);
  if (content) return content.path;
  // Strip plain monitor prefix (agents sometimes include their own monitor)
  return uri.replace(MONITOR_PREFIX_RE, '');
}
