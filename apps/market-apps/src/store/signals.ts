// Every piece of mutable app state lives here and nowhere else. Modules that
// derive from it (queries.ts, selectors.ts) and modules that drive it (actions/)
// import from this file, so there is exactly one definition of each signal.

import { createSignal } from '@bundled/solid-js';
import { GITHUB_STATUS_HEALTHY, SIGNED_OUT_ACCOUNT } from '../constants.js';
import type { Account, GithubStatus, InstalledApp, ListedApp, PendingPublish } from '../types.js';

// ── Catalog ────────────────────────────────────────────────────────────

export const [marketApps, setMarketApps] = createSignal<ListedApp[]>([]);
export const [installedApps, setInstalledApps] = createSignal<InstalledApp[]>([]);
export const [statusText, setStatusText] = createSignal('Waiting for data…');
export const [lastUpdated, setLastUpdated] = createSignal('');
export const [loading, setLoading] = createSignal(false);

// ── Filters ────────────────────────────────────────────────────────────

export const [hideInstalled, setHideInstalled] = createSignal(false);
export const [search, setSearch] = createSignal('');

/**
 * Which field the search box filters on, plus an 'official'-only view. This tuple
 * is the source of truth for the SearchMode type. Two places repeat the values as
 * literals and must be kept in step by hand: the JSON Schema enum in main.ts (the
 * protocol extractor reads it statically) and the dropdown's <option> elements in
 * components/search-bar.ts (Solid needs them present as it applies the value).
 */
export const SEARCH_MODES = ['title', 'author', 'official'] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];
export const [searchMode, setSearchMode] = createSignal<SearchMode>('title');

// ── Publisher account ──────────────────────────────────────────────────

export const [account, setAccount] = createSignal<Account>(SIGNED_OUT_ACCOUNT);
export const [authBusy, setAuthBusy] = createSignal(false);

// ── Publish dialog ─────────────────────────────────────────────────────

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

// ── Ambient status ─────────────────────────────────────────────────────

/** Starts healthy so nothing flashes on screen before the first check answers. */
export const [githubStatus, setGithubStatus] = createSignal<GithubStatus>(GITHUB_STATUS_HEALTHY);

// ── Status line ───────────────────────────────────────────────────────

export function touch(): void {
  setLastUpdated(new Date().toLocaleString());
}

export function setStatus(next: string, stamp = true): void {
  setStatusText(next);
  if (stamp) touch();
}
