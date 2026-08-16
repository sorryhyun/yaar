// Reconciling "what the host says is installed" with "what this window just installed".
//
// The host's app list can lag a successful install by a moment, or answer without
// version metadata. Left alone, that briefly un-installs a card the user just
// installed, or labels an owned app "Publish update" against a version we already
// know. The records below bridge exactly that gap, and expire on their own.

import { createSignal } from '@bundled/solid-js';
import { INSTALL_RECONCILIATION_GRACE_MS } from '../constants.js';
import { normalizeId, sameAppId } from '../parsers/index.js';
import type { InstalledApp, ListedApp } from '../types.js';
import { installedApps, marketApps, setInstalledApps, setMarketApps } from './signals.js';

/**
 * Marketplace versions that this window successfully installed. The host list can
 * briefly lag an install (or omit its version), so these records bridge that gap.
 * They are removed only when a post-grace authoritative list no longer contains
 * the app, or when the user uninstalls it.
 */
type MarketplaceInstallRecord = { id: string; name: string; version?: string; recordedAt: number };

// The one signal that lives outside signals.ts, and only because nothing outside
// this module may touch it: it is bookkeeping for the merge below, not app state.
const [marketplaceInstallRecords, setMarketplaceInstallRecords] = createSignal<
  Record<string, MarketplaceInstallRecord>
>({});

function syncMarketInstallationFlags(): void {
  const installedIds = new Set(installedApps().map((a) => normalizeId(a.id)));
  setMarketApps(
    marketApps().map((m) => ({ ...m, installed: installedIds.has(normalizeId(m.id)) })),
  );
}

function isWithinInstallGrace(record: MarketplaceInstallRecord, requestStartedAt: number): boolean {
  return requestStartedAt - record.recordedAt < INSTALL_RECONCILIATION_GRACE_MS;
}

/**
 * Merge a host list with installs this window just completed.
 *
 * A list request that started before (or within the grace period after) an install
 * is not allowed to replace the newly installed marketplace version with an older
 * snapshot. Once a later request has had time to observe the install, its version
 * wins. This also keeps a known marketplace version when the host list omits
 * version metadata, which is common for lightweight list responses.
 */
export function reconcileInstalledApps(
  authoritative: InstalledApp[],
  requestStartedAt = Date.now(),
): void {
  const records = marketplaceInstallRecords();
  const remainingRecords = { ...records };
  const merged = [...authoritative];

  for (const [id, record] of Object.entries(records)) {
    const index = merged.findIndex((app) => normalizeId(app.id) === id);
    const protectOptimisticVersion = isWithinInstallGrace(record, requestStartedAt);

    if (index >= 0) {
      const hostApp = merged[index];
      // During the install grace window, the catalog version is the only result
      // known to have produced the successful install. Afterward the host wins.
      const version = protectOptimisticVersion
        ? (record.version ?? hostApp.version)
        : (hostApp.version ?? record.version);
      merged[index] = { ...hostApp, ...(version ? { version } : {}) };
      continue;
    }

    if (protectOptimisticVersion) {
      merged.push({
        id: record.id,
        name: record.name,
        ...(record.version ? { version: record.version } : {}),
      });
    } else {
      // A list begun after the grace period did not find it: accept that
      // authoritative absence and stop showing the optimistic install.
      delete remainingRecords[id];
    }
  }

  setMarketplaceInstallRecords(remainingRecords);
  setInstalledApps(merged);
  syncMarketInstallationFlags();
}

/**
 * Record the catalog version at the instant host installation succeeds. This is
 * intentionally synchronous so card rendering never waits for the slower list
 * refresh to learn the local app.json version.
 */
export function recordMarketplaceInstall(app: Pick<ListedApp, 'id' | 'name' | 'version'>): void {
  const key = normalizeId(app.id);
  const record: MarketplaceInstallRecord = {
    id: app.id,
    name: app.name,
    ...(app.version ? { version: app.version } : {}),
    recordedAt: Date.now(),
  };
  setMarketplaceInstallRecords({ ...marketplaceInstallRecords(), [key]: record });

  const existing = installedApps().find((installed) => sameAppId(installed.id, app.id));
  const next: InstalledApp = {
    id: app.id,
    name: app.name,
    ...(existing?.kind ? { kind: existing.kind } : {}),
    ...(app.version
      ? { version: app.version }
      : existing?.version
        ? { version: existing.version }
        : {}),
  };
  setInstalledApps([
    ...installedApps().filter((installed) => !sameAppId(installed.id, app.id)),
    next,
  ]);
  syncMarketInstallationFlags();
}

export function markInstalledSignal(app: { id: string; name: string }, installed: boolean): void {
  if (installed) {
    // Kept for non-market callers. Marketplace installs use recordMarketplaceInstall
    // so their published version is available immediately.
    if (!installedApps().some((a) => sameAppId(a.id, app.id))) {
      setInstalledApps([...installedApps(), { id: app.id, name: app.name }]);
    }
  } else {
    const key = normalizeId(app.id);
    const records = { ...marketplaceInstallRecords() };
    delete records[key];
    setMarketplaceInstallRecords(records);
    setInstalledApps(installedApps().filter((a) => !sameAppId(a.id, app.id)));
  }
  syncMarketInstallationFlags();
}
