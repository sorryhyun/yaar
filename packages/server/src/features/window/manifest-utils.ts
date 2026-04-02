/**
 * Shared helper for enriching app-protocol manifests with yaar:// resource URIs.
 */

import type { AppManifest } from '@yaar/shared';
import type { WindowHandleMap } from '../../session/window-handle-map.js';
import { buildWindowResourceUri } from '../../lib/yaar-uri-server.js';

/**
 * Add `uri` fields to each state key and command in a manifest response.
 * `windowKey` is the internal handle (e.g., "0/win-excel").
 */
export function enrichManifestWithUris(
  manifest: AppManifest,
  windowKey: string,
  handleMap: WindowHandleMap,
): void {
  const rawId = handleMap.getRawWindowId(windowKey);

  for (const [key, desc] of Object.entries(manifest.state)) {
    (desc as unknown as Record<string, unknown>).uri = buildWindowResourceUri(rawId, 'state', key);
  }
  for (const [key, desc] of Object.entries(manifest.commands)) {
    (desc as unknown as Record<string, unknown>).uri = buildWindowResourceUri(
      rawId,
      'commands',
      key,
    );
  }
}
