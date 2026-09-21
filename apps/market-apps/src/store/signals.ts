// Every piece of mutable app state lives here and nowhere else. Modules that
// derive from it (queries.ts, selectors.ts) and modules that drive it (actions/)
// import from this file, so there is exactly one definition of each signal.

import { createSignal } from '@bundled/solid-js';
import { createSharedSignal } from '@bundled/yaar';
import { GITHUB_STATUS_HEALTHY, IDLE_UPDATE_RUN, SIGNED_OUT_ACCOUNT } from '../constants.js';
import type {
  Account,
  GithubStatus,
  InstalledApp,
  ListedApp,
  PendingPublish,
  PublishResult,
  UpdateRun,
} from '../types.js';

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

// ── Update All ───────────────────────────────────────────────

/**
 * Progress of the bulk update. Written only by `actions/update-all.ts`. For display
 * and the protocol; the concurrency guard is `runInFlight` in that file.
 */
export const [updateRun, setUpdateRun] = createSignal<UpdateRun>(IDLE_UPDATE_RUN);

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

/** The last protocol `publish` to settle, or null before one has. Written only by `publishForAgent`. */
export const [lastPublish, setLastPublish] = createSignal<PublishResult | null>(null);

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

// ── Shared across copies of this window ─────────────────────────────────
//
// A protocol command runs in whichever copy the server picked to answer, so a
// plain signal only updates that copy's screen. These cover the state a command
// sets that a follower has no other way to reconstruct. The normal catalog
// refresh, single-app install/uninstall, account and GitHub-status polling are
// deliberately left alone: those are freely re-fetchable from the host, so a
// follower is at worst one refresh behind rather than permanently wrong.

/** Written only by `setData`/`clearData` — the two commands that hand the app data
 * with no host round trip behind it, so a follower cannot re-fetch its way there. */
export const [sharedCatalog, setSharedCatalog] = createSharedSignal<{
  marketApps: ListedApp[];
  installedApps: InstalledApp[];
} | null>('catalog', null, {
  onRemote: (next) => {
    if (!next) return;
    setMarketApps(next.marketApps);
    setInstalledApps(next.installedApps);
  },
});

/** Written by `setData`, `setStatus` and `clearData` — an arbitrary or synthesized
 * line a follower could not otherwise recompute (unlike a normal action's status,
 * which just narrates a host call the follower could make for itself). */
export const [sharedStatus, setSharedStatus] = createSharedSignal<string | null>('status', null, {
  onRemote: (text) => text != null && setStatus(text),
});

/** Written by `setHideInstalled`, `setSearch` and `setSearchMode`. */
export const [sharedFilters, setSharedFilters] = createSharedSignal<{
  hideInstalled: boolean;
  search: string;
  searchMode: SearchMode;
} | null>('filters', null, {
  onRemote: (next) => {
    if (!next) return;
    setHideInstalled(next.hideInstalled);
    setSearch(next.search);
    setSearchMode(next.searchMode);
  },
});

/** Written wherever `setUpdateRun` runs (actions/update-all.ts) — the `updateAll`
 * command's progress, whether it was started by the agent or the header button. */
export const [sharedUpdateRun, setSharedUpdateRun] = createSharedSignal<UpdateRun | null>(
  'update-run',
  null,
  { onRemote: (next) => next && setUpdateRun(next) },
);

/** Written once, by the `publish` command's own settle point (actions/publish.ts). */
export const [sharedLastPublish, setSharedLastPublish] = createSharedSignal<PublishResult | null>(
  'last-publish',
  null,
  { onRemote: (next) => next && setLastPublish(next) },
);
