/**
 * Shared helper for enriching app-protocol manifests with yaar:// resource URIs.
 */

import type { AppManifest } from '@yaar/shared';
import { parseWindowKey } from '@yaar/shared';
import { buildWindowResourceUri } from '../../lib/yaar-uri-server.js';

/**
 * Add `uri` fields to each state key and command in a manifest response.
 * `windowKey` is the internal scoped key (e.g., "0/win-excel").
 */
export function enrichManifestWithUris(manifest: AppManifest, windowKey: string): void {
  const parsed = parseWindowKey(windowKey);
  if (!parsed) return;

  for (const [key, desc] of Object.entries(manifest.state)) {
    (desc as unknown as Record<string, unknown>).uri = buildWindowResourceUri(
      parsed.monitorId,
      parsed.windowId,
      'state',
      key,
    );
  }
  for (const [key, desc] of Object.entries(manifest.commands)) {
    (desc as unknown as Record<string, unknown>).uri = buildWindowResourceUri(
      parsed.monitorId,
      parsed.windowId,
      'commands',
      key,
    );
  }
}
