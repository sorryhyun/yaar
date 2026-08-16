// Questions asked about a *single* app, all answered from the live signals so that
// every caller reads the same snapshot. The card's "Install update" branch and its
// publish button used to compare versions independently and disagree about the same
// app; both now come from `installedVersionOrder` below.

import { OFFICIAL_AUTHORS } from '../constants.js';
import { compareVersions, normalizeId } from '../parsers/index.js';
import type { VersionOrder } from '../parsers/index.js';
import type { ListedApp } from '../types.js';
import { account, installedApps } from './signals.js';

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

/** Whether an app is authored by YAAR / the official publisher. */
export function isOfficialAuthor(author?: string): boolean {
  if (!author) return false;
  return OFFICIAL_AUTHORS.includes(author.trim().toLowerCase());
}