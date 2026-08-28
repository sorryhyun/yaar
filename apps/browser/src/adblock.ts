/**
 * Ad, popup and overlay suppression — the app-side half.
 *
 * ## Three layers
 *
 * 1. **Network** — `web.setRequestBlocking` hands `hosts`/`urlPatterns` to Chrome's
 *    own blocklist, so a matching request never leaves the tab. The only layer that
 *    saves bandwidth or stops a tracker beacon.
 * 2. **Init script** — `web.setInitScript` installs `initScript` to run before any
 *    page script, so `window.open` is ours before a popunder can bind it.
 * 3. **DOM** — `applyScript`, injected after load on every navigation via the SSE
 *    url frame (`sse.ts`): hides ad elements, strips interstitials, unlocks scroll.
 *    The reversible layer; everything it touches goes on a ledger.
 *
 * Layers 1 and 2 are PROVIDER-WIDE on the server — every tab, including the popup
 * an ad opens later — so they are set from the *active* tab's point of view: on
 * when blocking is on and the page on screen is not exempt, off otherwise. A site
 * exemption is therefore global while that site is on screen.
 *
 * ## Imports
 *
 * Only `store.ts` (which imports `url.ts` and nothing else), so `sse.ts` can import
 * this without closing a cycle. Deliberately does NOT import `session.ts` — command
 * handlers pass a browserId in, per the AGENTS.md rule about `ensureBrowserId`.
 */
import { createSignal } from '@bundled/solid-js';
import * as z from '@bundled/zod';
import { appStorage, createPersistedSignal, safeParseOr } from '@bundled/yaar';
import * as web from '@bundled/yaar-web';
import { activeBrowserId, currentUrl } from './store';
import {
  applyScript,
  disableScript,
  initScript,
  statsScript,
  type BlockConfig,
  type BlockStats,
} from './adblock-script';

/** Where the user-editable rules live in this app's storage. */
const RULES_PATH = 'blocklist.json';

export interface BlockRules extends BlockConfig {
  /** Hosts the blocker leaves alone entirely. Persisted per site by set_ad_block. */
  allowDomains: string[];
}

/*
 * Selectors are anchored on purpose. `[id*=ad]` — which the obvious version of
 * this list reaches for — also matches "header", "download", "gradient", "read"
 * and "loading", so it hides page furniture on a majority of sites. Prefix and
 * suffix anchors cost a little recall and buy back the false positives.
 */
export const DEFAULT_RULES: BlockRules = {
  hosts: [
    'doubleclick.net',
    'googlesyndication.com',
    'googleadservices.com',
    'google-analytics.com',
    'googletagmanager.com',
    'adnxs.com',
    'taboola.com',
    'outbrain.com',
    'popads.net',
    'popcash.net',
    'propellerads.com',
    'propellerclick.com',
    'exoclick.com',
    'juicyads.com',
    'trafficjunky.net',
    'hilltopads.net',
    'adsterra.com',
    'mgid.com',
    'revcontent.com',
    'zedo.com',
    'adcash.com',
    'clickadu.com',
  ],
  urlPatterns: ['/ads/', '/adserver/', '/adframe', 'popunder', 'popads', '/banners/'],
  selectors: [
    'ins.adsbygoogle',
    '.adsbygoogle',
    'iframe[id^="google_ads"]',
    'iframe[name^="google_ads"]',
    'iframe[id^="aswift_"]',
    '[id^="ad-"]',
    '[id$="-ad"]',
    '[id^="ads-"]',
    '[class^="ad-banner"]',
    '[class*="advertisement"]',
    '[data-ad-slot]',
    '[aria-label="Advertisement"]',
  ],
  allowDomains: [],
  minZIndex: 1000,
  minCoverage: 0.5,
};

/*
 * Every field optional and loose: this file is meant to be hand-edited, and a user
 * who deletes a key they do not care about should get the default back rather than
 * a validation failure that disables blocking entirely.
 */
const RulesSchema = z.looseObject({
  hosts: z.optional(z.array(z.string())),
  urlPatterns: z.optional(z.array(z.string())),
  selectors: z.optional(z.array(z.string())),
  allowDomains: z.optional(z.array(z.string())),
  minZIndex: z.optional(z.number()),
  minCoverage: z.optional(z.number()),
});

const [rules, setRules] = createSignal<BlockRules>(DEFAULT_RULES);
const [blockedCount, setBlockedCount] = createSignal(0);
/** Requests Chrome refused on the page on screen; part of the badge. */
const [networkBlocked, setNetworkBlocked] = createSignal(0);
/** Popups the server saw this tab open, newest last. Reset per navigation. */
const [popupTabs, setPopupTabs] = createSignal<PopupTab[]>([]);

export interface PopupTab {
  browserId: string;
  url: string;
}

/**
 * The master switch. Default ON, persisted across sessions.
 *
 * A plain boolean rather than part of blocklist.json: it is flipped by a toolbar
 * click, and `createPersistedSignal` is exactly the write-on-every-set shape a
 * toggle wants.
 */
export const [adBlockEnabled, setAdBlockEnabled, adBlockReady] = createPersistedSignal<boolean>(
  'adblock-enabled.json',
  true,
  { label: 'ad blocker setting' },
);

export { blockedCount, networkBlocked, popupTabs, rules };

/** Merge a stored partial over the defaults so a missing key is a default, not a hole. */
function merge(raw: unknown): BlockRules {
  const parsed = safeParseOr(RulesSchema, raw, undefined, { label: 'adblock:blocklist' });
  if (!parsed) return DEFAULT_RULES;
  return {
    hosts: parsed.hosts ?? DEFAULT_RULES.hosts,
    urlPatterns: parsed.urlPatterns ?? DEFAULT_RULES.urlPatterns,
    selectors: parsed.selectors ?? DEFAULT_RULES.selectors,
    allowDomains: parsed.allowDomains ?? DEFAULT_RULES.allowDomains,
    minZIndex: parsed.minZIndex ?? DEFAULT_RULES.minZIndex,
    minCoverage: parsed.minCoverage ?? DEFAULT_RULES.minCoverage,
  };
}

/** Read blocklist.json, writing the defaults out on first run so it is there to edit. */
export async function loadRules(): Promise<BlockRules> {
  const raw = await appStorage.readJsonOr<unknown>(RULES_PATH, undefined);
  if (raw === undefined) {
    void appStorage.trySave(RULES_PATH, JSON.stringify(DEFAULT_RULES, null, 2), {
      label: 'blocklist.json',
    });
    setRules(DEFAULT_RULES);
    return DEFAULT_RULES;
  }
  const merged = merge(raw);
  setRules(merged);
  return merged;
}

async function saveRules(next: BlockRules): Promise<void> {
  setRules(next);
  await appStorage.trySave(RULES_PATH, JSON.stringify(next, null, 2), { label: 'blocklist.json' });
}

/** Host of a URL, lowercased, or '' when it has none (about:blank, a bad value). */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** True when `host` is an exempt domain or a subdomain of one. */
export function isExempt(host: string, list: string[] = rules().allowDomains): boolean {
  if (!host) return false;
  return list.some((d) => {
    const bare = d.toLowerCase().replace(/^\./, '');
    return host === bare || host.endsWith(`.${bare}`);
  });
}

/** Whether blocking should run for the page currently on screen. */
export function activeHere(url: string): boolean {
  if (!adBlockEnabled()) return false;
  if (!url || url === 'about:blank') return false;
  return !isExempt(hostOf(url));
}

/**
 * The result envelope as one flat shape rather than the SDK's union.
 *
 * This project compiles without strictNullChecks, so a discriminated union does
 * not narrow through `ok` at all and `res.error` is an error on every branch.
 * `protocol.ts` flattens `web.screenshot`'s envelope for the same reason.
 */
type EvalEnvelope = { ok: boolean; data?: unknown; error?: string };

async function evaluate(browserId: string, expression: string): Promise<unknown> {
  const res = (await web.evaluate({ expression, browserId })) as EvalEnvelope;
  if (res.ok) return res.data;
  throw new Error(res.error ?? 'evaluate failed');
}

function asStats(data: unknown): BlockStats | null {
  if (!data || typeof data !== 'object') return null;
  const s = data as Partial<BlockStats>;
  return typeof s.blocked === 'number' ? (s as BlockStats) : null;
}

type NetStats = { blocked: number; requests: number; enabled: boolean };

/** The server-side counter for one tab; 0s when the server cannot say. */
async function readNetworkStats(browserId: string): Promise<NetStats> {
  const res = (await web.getRequestBlockStats({ browserId })) as EvalEnvelope;
  const d = res.ok ? (res.data as Partial<NetStats>) : null;
  return {
    blocked: typeof d?.blocked === 'number' ? d.blocked : 0,
    requests: typeof d?.requests === 'number' ? d.requests : 0,
    enabled: d?.enabled === true,
  };
}

/** One number for the badge: elements hidden + popups swallowed + requests refused. */
function publish(stats: BlockStats | null, net: NetStats): void {
  setNetworkBlocked(net.blocked);
  setBlockedCount((stats?.blocked ?? 0) + net.blocked);
}

/**
 * The server half, set from the active tab's point of view (see the header).
 * Keyed on what was last sent, so the per-navigation calls cost nothing while
 * nothing changed — the profile is provider-wide and does not need re-sending.
 */
let serverShieldKey = '';

async function syncServerShield(active: boolean): Promise<void> {
  const r = rules();
  const key = active ? JSON.stringify([r.hosts, r.urlPatterns]) : 'off';
  if (key === serverShieldKey) return;
  serverShieldKey = key;
  const [blocking, init] = await Promise.all([
    web.setRequestBlocking({
      enabled: active,
      rules: { hosts: r.hosts, urlPatterns: r.urlPatterns },
    }) as Promise<EvalEnvelope>,
    web.setInitScript({ script: active ? initScript : '' }) as Promise<EvalEnvelope>,
  ]);
  if (!blocking.ok || !init.ok) {
    // Re-sent next time rather than believed to be in place.
    serverShieldKey = '';
    throw new Error(blocking.error ?? init.error ?? 'shield sync failed');
  }
}

/** Install (or re-sweep) the blocker in the given tab. */
export async function applyAdBlock(browserId: string): Promise<BlockStats | null> {
  const { allowDomains: _ignored, ...cfg } = rules();
  const [stats, net] = await Promise.all([
    evaluate(browserId, applyScript(cfg)).then(asStats),
    readNetworkStats(browserId),
  ]);
  publish(stats, net);
  return stats;
}

/** Undo everything the blocker did in the given tab, restoring the page as it was. */
export async function removeAdBlock(browserId: string): Promise<void> {
  await evaluate(browserId, disableScript);
  setBlockedCount(0);
  setNetworkBlocked(0);
}

export async function refreshStats(browserId: string): Promise<BlockStats | null> {
  const [stats, net] = await Promise.all([
    evaluate(browserId, statsScript).then(asStats),
    readNetworkStats(browserId),
  ]);
  publish(stats, net);
  return stats;
}

/** Fire-and-forget wrapper: this runs off navigation frames, where nothing can await it. */
function attempt(what: string, fn: () => Promise<unknown>): void {
  void fn().catch((err) => {
    console.warn(`[browser] ad block ${what} failed:`, err);
  });
}

// ── Reacting to navigation ──────────────────────────────────────────────────

let lastUrl = '';
let settleTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * A page load is not one event. The SSE stream reports a url the moment the
 * navigation commits, long before the ads that motivate this feature have been
 * inserted, so one injection at commit time would sweep an empty document. The
 * second pass at SETTLE_MS is what actually catches them; the MutationObserver
 * installed by the first pass covers everything later.
 */
const SETTLE_MS = 1500;

export function onNavigated(url: string): void {
  if (url === lastUrl) return;
  lastUrl = url;
  setPopupTabs([]);
  if (settleTimer) clearTimeout(settleTimer);
  const browserId = activeBrowserId();
  setBlockedCount(0);
  setNetworkBlocked(0);
  if (!activeHere(url)) {
    // The init script ran on this page before we learned it was exempt; DISABLE
    // gives `window.open` back (a no-op when nothing was installed).
    attempt('shield off', async () => {
      await syncServerShield(false);
      await removeAdBlock(browserId);
    });
    return;
  }
  attempt('shield on', () => syncServerShield(true));
  attempt('inject', () => applyAdBlock(browserId));
  settleTimer = setTimeout(() => {
    settleTimer = null;
    if (activeBrowserId() !== browserId || !activeHere(lastUrl)) return;
    attempt('re-sweep', () => applyAdBlock(browserId));
  }, SETTLE_MS);
}

/**
 * The server announces a popup on its opener's SSE stream (`sse.ts`), with the
 * opener it recorded from Chrome — authoritative in a way the in-page counter is
 * not. Recorded and counted, never closed: a popunder's *new* tab is the page the
 * user meant to open, and an OAuth popup is a login in progress.
 */
export function onPopup(popup: PopupTab): void {
  setPopupTabs((list) => [...list, popup]);
  setBlockedCount((n) => n + 1);
  console.info(`[browser] popup ${popup.browserId} → ${popup.url}`);
}

/**
 * Keep the toolbar badge honest while the observer keeps working.
 *
 * Polled rather than pushed because the count lives in the remote page and there
 * is no channel out of it. Skipped when the window is hidden, so a backgrounded
 * browser costs nothing.
 */
const STATS_POLL_MS = 5000;
let statsTimer: ReturnType<typeof setInterval> | null = null;

export function startStatsPolling(): void {
  if (statsTimer) return;
  statsTimer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (!activeHere(lastUrl)) return;
    attempt('stats', () => refreshStats(activeBrowserId()));
  }, STATS_POLL_MS);
}

export function stopStatsPolling(): void {
  if (!statsTimer) return;
  clearInterval(statsTimer);
  statsTimer = null;
}

// ── The switches the toolbar and the protocol share ─────────────────────────

/**
 * Turn blocking on or off, globally or for the current site.
 *
 * Takes effect on the page already on screen rather than at the next navigation:
 * a user turning this off is usually looking at something the blocker just broke,
 * and "reload to undo" is not an undo.
 */
export async function setAdBlock(
  enabled: boolean,
  scope: 'global' | 'site' = 'global',
  browserId: string = activeBrowserId(),
): Promise<{ adBlockEnabled: boolean; scope: string; site?: string; allowDomains: string[] }> {
  const site = hostOf(lastUrl);

  if (scope === 'site') {
    if (!site) throw new Error('No site is loaded, so there is nothing to add an exception for.');
    const current = rules();
    const without = current.allowDomains.filter((d) => d.toLowerCase() !== site);
    // An exception is the inverse of the switch: enabled here means "block on this
    // site", which is expressed by NOT being on the allow list.
    await saveRules({ ...current, allowDomains: enabled ? without : [...without, site] });
  } else {
    setAdBlockEnabled(enabled);
  }

  const shouldRun = activeHere(lastUrl);
  await syncServerShield(shouldRun).catch((err) => {
    console.warn('[browser] ad block shield sync failed:', err);
  });
  if (shouldRun) await applyAdBlock(browserId).catch(() => null);
  else await removeAdBlock(browserId).catch(() => null);

  if (adBlockEnabled()) startStatsPolling();
  else stopStatsPolling();

  return {
    adBlockEnabled: adBlockEnabled(),
    scope,
    site: site || undefined,
    allowDomains: rules().allowDomains,
  };
}

/** The toolbar's shield button. */
export async function toggleAdBlock(): Promise<void> {
  await setAdBlock(!adBlockEnabled(), 'global');
}

/** Alt-click on the shield: exempt this site, or take the exemption back. */
export async function toggleSiteException(): Promise<void> {
  await setAdBlock(isExempt(hostOf(lastUrl)), 'site');
}

/** True when the page on screen is exempt — what makes the shield read differently. */
export function currentSiteExempt(): boolean {
  return isExempt(hostOf(lastUrl));
}

export type RuleKind = 'host' | 'urlPattern' | 'selector';

/**
 * Guess which list a rule belongs in, so the command can take a bare pattern.
 *
 * CSS punctuation is decisive; a slash means a path fragment; anything else that
 * looks like a domain is a host. Callers that disagree pass `kind` explicitly.
 */
/*
 * `ins.adsbygoogle` and `example.com` have the same shape, so the tag list is the
 * tiebreaker for the form that is genuinely ambiguous. Everything else is decided
 * by punctuation, and `kind` overrides all of it.
 */
const TAG_PREFIX =
  /^(a|div|span|section|aside|iframe|ins|img|p|ul|li|table|form|button|video|header|footer|nav)[.#[]/i;

export function classifyRule(pattern: string): RuleKind {
  const p = pattern.trim();
  if (/^[.#[]/.test(p) || /[>\s:]/.test(p)) return 'selector';
  if (TAG_PREFIX.test(p)) return 'selector';
  if (p.includes('/')) return 'urlPattern';
  return 'host';
}

/**
 * A rule kind names one list, and the two are spelled differently — singular kind,
 * plural field. Indexing the rules by the kind directly reads `undefined`, and the
 * project's TypeScript settings do not catch it (no noImplicitAny), so the mapping
 * is written out rather than assumed.
 */
const RULE_FIELD: Record<RuleKind, 'hosts' | 'urlPatterns' | 'selectors'> = {
  host: 'hosts',
  urlPattern: 'urlPatterns',
  selector: 'selectors',
};

export async function addBlockRule(
  pattern: string,
  kind?: RuleKind,
): Promise<{ added: string; kind: RuleKind; field: string; total: number }> {
  const value = pattern.trim();
  if (!value) throw new Error('Pattern is empty.');
  const target = kind ?? classifyRule(value);
  const field = RULE_FIELD[target];
  const current = rules();
  const list = current[field];
  if (!list.includes(value)) {
    await saveRules({ ...current, [field]: [...list, value] });
    // A host/URL rule is also a network rule; the key changed, so this re-sends.
    if (activeHere(lastUrl)) attempt('shield update', () => syncServerShield(true));
  }
  return { added: value, kind: target, field, total: rules()[field].length };
}

/**
 * Load persisted settings, then block whatever is already on screen.
 *
 * Called once from main.ts. The `?url=` launch navigation and the first SSE frame
 * both race this, which is why it ends by sweeping the current page rather than
 * trusting `onNavigated` to have been reached.
 */
export async function initAdBlock(): Promise<void> {
  await Promise.all([loadRules(), adBlockReady]);
  if (!adBlockEnabled()) {
    // Another window of this app may have left the provider-wide shield on.
    attempt('shield off', () => syncServerShield(false));
    return;
  }
  startStatsPolling();
  // The window routinely opens onto a page that is ALREADY loaded — a remount, or
  // a session someone else navigated. No url frame changes in that case, so
  // `onNavigated` never fires and the first sweep has to be ordered here.
  const url = currentUrl();
  lastUrl = url;
  const active = activeHere(url);
  attempt('shield', () => syncServerShield(active));
  if (!active) return;
  attempt('initial sweep', () => applyAdBlock(activeBrowserId()));
}
