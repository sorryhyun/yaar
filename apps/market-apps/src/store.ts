// ── Reactive store ────────────────────────────────────────────────────────
//
// All reactive state (signals) plus the small helpers that read/derive/mutate it.
// Pure data transforms live in parsers.ts; network + business logic in api.ts /
// actions.ts. Keeping signals in one module gives every other module a single,
// non-circular place to import shared state from.

import { createSignal } from '@bundled/solid-js';
import { storage } from '@bundled/yaar';
import { STORAGE_DOMAIN_KEY, SIGNED_OUT_ACCOUNT, GITHUB_STATUS_HEALTHY } from './constants.js';
import { normalizeDomain, normalizeId, sameAppId } from './parsers.js';
import type { Account, DisplayApp, GithubStatus, InstalledApp, ListedApp } from './types.js';

// ── Signals ─────────────────────────────────────────────────────────────

export const [marketApps, setMarketApps] = createSignal<ListedApp[]>([]);
export const [installedApps, setInstalledApps] = createSignal<InstalledApp[]>([]);
export const [statusText, setStatusText] = createSignal('Waiting for data…');
export const [lastUpdated, setLastUpdated] = createSignal('');
export const [loading, setLoading] = createSignal(false);
export const [apiBase, setApiBase] = createSignal('');
export const [hideInstalled, setHideInstalled] = createSignal(false);

export const [account, setAccount] = createSignal<Account>(SIGNED_OUT_ACCOUNT);
export const [authBusy, setAuthBusy] = createSignal(false);

/** Starts healthy so nothing flashes on screen before the first check answers. */
export const [githubStatus, setGithubStatus] = createSignal<GithubStatus>(GITHUB_STATUS_HEALTHY);

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
  if (d) void storage.save(STORAGE_DOMAIN_KEY, d);
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

export function markInstalledSignal(app: { id: string; name: string }, installed: boolean): void {
  if (installed) {
    if (!installedApps().some((a) => sameAppId(a.id, app.id))) {
      setInstalledApps([...installedApps(), { id: app.id, name: app.name }]);
    }
  } else {
    setInstalledApps(installedApps().filter((a) => !sameAppId(a.id, app.id)));
  }
  setMarketApps(marketApps().map((m) => (sameAppId(m.id, app.id) ? { ...m, installed } : m)));
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
  }));
  const installedOnly: DisplayApp[] = installedApps()
    .filter((a) => !marketIds.has(normalizeId(a.id)))
    .map((a) => ({ id: a.id, name: a.name, kind: a.kind, installed: true, notPublished: true }));
  return [...marketMapped, ...installedOnly];
}

/** Apps visible after applying the Hide Installed filter. */
export function visibleApps(): DisplayApp[] {
  const apps = displayApps();
  return hideInstalled() ? apps.filter((a) => !a.installed) : apps;
}
