import { createSignal } from '@bundled/solid-js';
import {
  INSTALL_RECONCILIATION_GRACE_MS,
  SIGNED_OUT_ACCOUNT,
  GITHUB_STATUS_HEALTHY,
} from './constants.js';
import { compareVersions, normalizeId, sameAppId } from './parsers.js';
import type { VersionOrder } from './parsers.js';
import type {
  Account,
  DisplayApp,
  GithubStatus,
  InstalledApp,
  ListedApp,
  PendingPublish,
} from './types.js';

export const [marketApps, setMarketApps] = createSignal<ListedApp[]>([]);
export const [installedApps, setInstalledApps] = createSignal<InstalledApp[]>([]);
export const [statusText, setStatusText] = createSignal('Waiting for data…');
export const [lastUpdated, setLastUpdated] = createSignal('');
export const [loading, setLoading] = createSignal(false);
export const [hideInstalled, setHideInstalled] = createSignal(false);
export const [search, setSearch] = createSignal('');

/** Which field the search box filters on, plus an 'official'-only view. */
export type SearchMode = 'title' | 'author' | 'official';
export const [searchMode, setSearchMode] = createSignal<SearchMode>('title');

export const [account, setAccount] = createSignal<Account>(SIGNED_OUT_ACCOUNT);
export const [authBusy, setAuthBusy] = createSignal(false);

/** The publish awaiting confirmation (freeze + digest), or null when no dialog is open. */
export const [pendingPublish, setPendingPublish] = createSignal<PendingPublish | null>(null);
/** True while a `publish_confirm` round-trip is in flight, to disable the dialog buttons. */
export const [confirmBusy, setConfirmBusy] = createSignal(false);
/**
 * The publisher-terms checkbox in the open dialog. Reset every time a dialog opens
 * or closes: consent is given for the publish in front of you, and a box left ticked
 * from a previous dialog would be agreement nobody re-read.
 */
export const [termsAgreed, setTermsAgreed] = createSignal(false);

/** Starts healthy so nothing flashes on screen before the first check answers. */
export const [githubStatus, setGithubStatus] = createSignal<GithubStatus>(GITHUB_STATUS_HEALTHY);

/**
 * Marketplace versions that this window successfully installed. The host list can
 * briefly lag an install (or omit its version), so these records bridge that gap.
 * They are removed only when a post-grace authoritative list no longer contains
 * the app, or when the user uninstalls it.
 */
type MarketplaceInstallRecord = { id: string; name: string; version?: string; recordedAt: number };
const [marketplaceInstallRecords, setMarketplaceInstallRecords] = createSignal<
  Record<string, MarketplaceInstallRecord>
>({});

function timeNow(): string {
  return new Date().toLocaleString();
}

export function touch(): void {
  setLastUpdated(timeNow());
}

export function setStatus(next: string, stamp = true): void {
  setStatusText(next);
  if (stamp) touch();
}

export function hasInstalled(appId: string): boolean {
  const target = normalizeId(appId);
  return installedApps().some((a) => normalizeId(a.id) === target);
}

/** Whether an installed app is a built-in system app (protected from uninstall). */
export function isSystem(appId: string): boolean {
  const target = normalizeId(appId);
  return installedApps().some((a) => normalizeId(a.id) === target && a.kind === 'system');
}

/** Whether the signed-in publisher owns this app id (per the marketplace). */
export function ownsApp(appId: string): boolean {
  const target = normalizeId(appId);
  return account().ownedApps.some((id) => normalizeId(id) === target);
}

/** The locally installed version of an app, or undefined if not installed / unknown. */
export function installedVersionOf(appId: string): string | undefined {
  const target = normalizeId(appId);
  return installedApps().find((a) => normalizeId(a.id) === target)?.version;
}

/**
 * How this machine's copy stands against the catalog — the one live read that both
 * the card's "Install update" branch and its publish button are decided from.
 *
 * They used to compare independently and disagree about the same app: the update
 * check demanded both versions parse, while the publish button treated "can't tell"
 * as publishable. Any app with a missing or non-numeric version therefore fell
 * through the first check and out of the second as an enabled "Publish update" —
 * offering to push a copy up that may be *older* than what is already published.
 */
export function installedVersionOrder(app: Pick<ListedApp, 'id' | 'version'>): VersionOrder {
  return compareVersions(installedVersionOf(app.id), app.version);
}

/** True only when the catalog is demonstrably newer than the installed copy. */
export function hasMarketplaceUpdate(app: Pick<ListedApp, 'id' | 'version'>): boolean {
  return installedVersionOrder(app) === 'older';
}

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

/**
 * The full card list: every marketplace app, plus apps installed locally that the
 * marketplace has never seen. The latter are what a developer publishes for the
 * first time — without them the UI could show sign-in but never a first Publish.
 *
 * Built-in system apps (dock, storage, the marketplace itself, …) are excluded:
 * they can't be uninstalled or published, so a marketplace card for them is dead
 * weight. They're kept out of the counts too by filtering at this single source.
 */
export function displayApps(): DisplayApp[] {
  const market = marketApps();
  const marketIds = new Set(market.map((m) => normalizeId(m.id)));
  const marketMapped: DisplayApp[] = market.map((m) => ({
    ...m,
    installed: m.installed || hasInstalled(m.id),
    installedVersion: installedVersionOf(m.id),
  }));
  const installedOnly: DisplayApp[] = installedApps()
    .filter((a) => !marketIds.has(normalizeId(a.id)))
    .map((a) => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      installed: true,
      notPublished: true,
      installedVersion: a.version,
    }));
  return [...marketMapped, ...installedOnly].filter((a) => a.kind !== 'system');
}

/**
 * The authors treated as first-party ("YAAR Official"). Compared case-insensitively,
 * so 'YAAR' as it displays in the UI and 'yaar' both match.
 */
const OFFICIAL_AUTHORS = ['yaar', 'standingbehindnv@gmail.com'];

/** Whether an app is authored by YAAR / the official publisher. */
export function isOfficialAuthor(author?: string): boolean {
  if (!author) return false;
  return OFFICIAL_AUTHORS.includes(author.trim().toLowerCase());
}

/**
 * Apps visible after applying the Hide Installed filter, the search-mode dropdown,
 * and the search query.
 *
 * - 'title'    — query matches name or description (the original behavior).
 * - 'author'   — query matches the author field instead.
 * - 'official' — restrict to YAAR-official apps; the query still filters within
 *                them by name/description.
 */
export function visibleApps(): DisplayApp[] {
  let apps = displayApps();
  if (hideInstalled()) apps = apps.filter((a) => !a.installed);

  const mode = searchMode();
  if (mode === 'official') {
    apps = apps.filter((a) => isOfficialAuthor(a.author));
  }

  const q = search().trim().toLowerCase();
  if (q) {
    apps =
      mode === 'author'
        ? apps.filter((a) => (a.author ?? '').toLowerCase().includes(q))
        : apps.filter(
            (a) =>
              a.name.toLowerCase().includes(q) || (a.description ?? '').toLowerCase().includes(q),
          );
  }
  return apps;
}
