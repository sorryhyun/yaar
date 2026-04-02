/**
 * Shared helper to resolve a windowId from a `uri` parameter.
 * Strips any monitor prefix so the raw window ID is returned.
 * Monitor scoping is handled separately by ActionEmitter + WindowStateRegistry.
 */

import { parseBareWindowUri, parseYaarUri } from '@yaar/shared';

/**
 * Resolve a windowId from a uri string.
 * - `yaar://windows/win-id`   → `win-id`    (canonical)
 * - `yaar://apps/word-lite`   → `word-lite`  (content URI → use app ID)
 * - `yaar://storage/doc.md`   → `doc.md`     (content URI → use path)
 * - `win-id`                  → `win-id`
 */
export function resolveWindowId(uri: string): string {
  // yaar://windows/{windowId}
  const bare = parseBareWindowUri(uri);
  if (bare) return bare.windowId;
  // Handle content URIs (yaar://apps/..., yaar://storage/...)
  const content = parseYaarUri(uri);
  if (content) return content.path;
  return uri;
}
