// ── Reactive store ────────────────────────────────────────────────────────
//
// All reactive state (signals) plus the small helpers that read/derive/mutate it.
// Pure data transforms live in parsers.ts; network + business logic in api.ts /
// actions.ts. Keeping signals in one module gives every other module a single,
// non-circular place to import shared state from.

import { createSignal } from '@bundled/solid-js';
import {
  INSTALL_RECONCILIATION_GRACE_MS,
  SIGNED_OUT_ACCOUNT,
  GITHUB_STATUS_HEALTHY,
} from './constants.js';
import { isNewerVersion, normalizeDomain, normalizeId, parseSemver, sameAppId } from './parsers.js';
import type {
  Account,
  DisplayApp,
  GithubStatus,
  InstalledApp,
  ListedApp,
  PendingPublish,
} from './types.js';

// ── Signals ─────────────────────────────────────────────────────────────

export const [marketApps, setMarketApps] = createSignal<ListedApp[]>([]);
export const [installedApps, setInstalledApps] = createSignal<InstalledApp[]>([]);
export const [statusText, setStatusText] = createSignal('Waiting for data…');
export const [lastUpdated, setLastUpdated] = createSignal('');
export const [loading, setLoading] = createSignal(false);
export const [apiBase, setApiBase] = createSignal('');
export const [hideInstalled, setHideInstalled] = createSignal(false);
export const [search, setSearch] = createSignal('');

export const [account, setAccount] = createSignal<Account>(SIGNED_OUT_ACCOUNT);
export const [authBusy, setAuthBusy] = createSignal(false);

/** The publish awaiting confirmation (freeze + digest), or null when no dialog is open. */
export const [pendingPublish, setPendingPublish] = createSignal<PendingPublish | null>(null);
/** True while a `publish_confirm` round-trip is in flight, to disable the dialog buttons. */
export const [confirmBusy, setConfirmBusy] = createSignal(false);

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

// ── Status helpers ──────────────────────────────────────────────────────

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

export function setDomain(nextDomain: string): void {
  const d = normalizeDomain(nextDomain);
  setApiBase(d);
  setStatus(d ? `Domain set: ${d}` : 'Domain cleared');
}

// ── Installed / ownership queries ──────────────────────────────────────────

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
 * True only when the catalog is demonstrably newer than the installed copy.
 *
 * `isNewerVersion` fails *open* — an unparseable version returns true — because it
 * gates the publish button, where the host refuses a stale publish as the backstop.
 * Claiming an update exists has no backstop: it would show "Install update" forever
 * on any app whose version isn't numeric dot-parts (`v1.2.0`, a codename), hide that
 * app's publish button, and re-download the identical bytes on every press. So both
 * sides must actually parse before we make the claim.
 */
export function hasMarketplaceUpdate(app: Pick<ListedApp, 'id' | 'version'>): boolean {
  const local = installedVersionOf(app.id);
  if (!app.version || !local) return false;
  if (!parseSemver(app.version) || !parseSemver(local)) return false;
  return isNewerVersion(app.version, local);
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

// ── Derived views ────────────────────────────────────────────────────

/**
 * The full card list: every marketplace app, plus apps installed locally that the
 * marketplace has never seen. The latter are what a developer publishes for the
 * first time — without them the UI could show sign-in but never a first Publish.
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
  return [...marketMapped, ...installedOnly];
}

/** Apps visible after applying the Hide Installed filter and the search query. */
export function visibleApps(): DisplayApp[] {
  let apps = displayApps();
  if (hideInstalled()) apps = apps.filter((a) => !a.installed);
  const q = search().trim().toLowerCase();
  if (q) {
    apps = apps.filter(
      (a) => a.name.toLowerCase().includes(q) || (a.description ?? '').toLowerCase().includes(q),
    );
  }
  return apps;
}
