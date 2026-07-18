export {};
import { createSignal, onMount } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import { invoke, del, list, storage, errMsg } from '@bundled/yaar';
import './styles.css';
import './protocol.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type ListedApp = {
  id: string;
  name: string;
  description?: string;
  version?: string;
  author?: string;
  icon?: string;
  installed?: boolean;
};

export type InstalledApp = {
  id: string;
  name: string;
  hasSkill?: boolean;
  /** 'system' apps are built-in and cannot be uninstalled. */
  kind?: string;
};

/** A card in the list — a marketplace app, an installed app, or both. */
export type DisplayApp = ListedApp & {
  kind?: string;
  /** Installed locally but not (yet) on the marketplace — publishable, not installable. */
  notPublished?: boolean;
};

/**
 * Publisher sign-in state, mirrored from the server's Google auth + the
 * marketplace's GET /api/me. The ID token never reaches this iframe — the server
 * makes the marketplace call and hands back only the email and owned app ids.
 */
export type Account = {
  /** GOOGLE_CLIENT_ID/SECRET are set on the server — sign-in is even possible. */
  configured: boolean;
  signedIn: boolean;
  email: string | null;
  /** A consent screen is open in the browser and has not come back yet. */
  pending: boolean;
  /** App ids this publisher owns, from the marketplace. */
  ownedApps: string[];
};

type ApiPayload = {
  apps?: ListedApp[];
  marketApps?: ListedApp[];
  installed?: InstalledApp[];
  installedApps?: InstalledApp[];
};

// ── Constants ────────────────────────────────────────────────────────────────

const STORAGE_DOMAIN_KEY = 'market_apps/domain.txt';
const DEFAULT_MARKET_DOMAIN = 'https://yaarmarket.vercel.app';

// ── Signals (reactive state) ─────────────────────────────────────────────────

export const [marketApps, setMarketApps] = createSignal<ListedApp[]>([]);
export const [installedApps, setInstalledApps] = createSignal<InstalledApp[]>([]);
export const [statusText, setStatusText] = createSignal('Waiting for data\u2026');
export const [lastUpdated, setLastUpdated] = createSignal('');
export const [loading, setLoading] = createSignal(false);
export const [apiBase, setApiBase] = createSignal('');
export const [hideInstalled, setHideInstalled] = createSignal(false);

const SIGNED_OUT_ACCOUNT: Account = {
  configured: false,
  signedIn: false,
  email: null,
  pending: false,
  ownedApps: [],
};
export const [account, setAccount] = createSignal<Account>(SIGNED_OUT_ACCOUNT);
export const [authBusy, setAuthBusy] = createSignal(false);

// ── Pure helper functions ────────────────────────────────────────────────────

function normalizeDomain(input?: string | null): string {
  const value = (input || '').trim();
  if (!value) return '';
  return value.replace(/\/+$/, '');
}

function normalizeId(value: string): string {
  return (value || '').trim().toLowerCase();
}

function sameAppId(a: string, b: string): boolean {
  return normalizeId(a) === normalizeId(b);
}

/** Returns the first truthy string among the given candidates, or null. */
function firstString(...values: unknown[]): string | null {
  for (const v of values) if (typeof v === 'string' && v) return v;
  return null;
}

function parseMarket(payload: ApiPayload): ListedApp[] {
  return Array.isArray(payload.marketApps)
    ? payload.marketApps
    : Array.isArray(payload.apps)
      ? payload.apps
      : [];
}

function parseInstalledText(text: string): InstalledApp[] {
  if (!text) return [];
  const result: InstalledApp[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*-\s+(.+?)\s+\(([^)]+)\)/);
    if (m) result.push({ id: m[2].trim(), name: m[1].trim() });
  }
  return result;
}

function coerceInstalledApp(input: unknown): InstalledApp | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  let id = firstString(obj.id, obj.appId, obj.slug, obj.packageName);
  // resource_link format: extract id from uri (yaar://apps/{appId})
  if (!id && typeof obj.uri === 'string') {
    const m = (obj.uri as string).match(/^yaar:\/\/apps\/([^/]+)/);
    if (m) id = m[1];
  }
  if (!id) return null;
  const name = firstString(obj.name, obj.title) ?? id;
  const kind = firstString(obj.kind);
  return { id, name, ...(kind ? { kind } : {}) };
}

/** Map a raw array to valid InstalledApp entries, dropping nulls. */
function parseInstalledList(items: unknown[]): InstalledApp[] {
  return items.map(coerceInstalledApp).filter((a): a is InstalledApp => a !== null);
}

function parseInstalledAny(input: unknown): InstalledApp[] {
  if (Array.isArray(input)) return parseInstalledList(input);

  if (typeof input === 'string') return parseInstalledText(input);

  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    const candidate = Array.isArray(obj.apps)
      ? obj.apps
      : Array.isArray(obj.installed)
        ? obj.installed
        : Array.isArray(obj.installedApps)
          ? obj.installedApps
          : [];

    if (candidate.length) {
      const parsed = parseInstalledList(candidate);
      if (parsed.length) return parsed;
    }

    if (typeof obj.text === 'string') return parseInstalledText(obj.text);
  }

  return [];
}

// ── Signal-aware helpers ─────────────────────────────────────────────────────

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

function hasInstalled(appId: string): boolean {
  const target = normalizeId(appId);
  return installedApps().some((a) => normalizeId(a.id) === target);
}

/** Whether an installed app is a built-in system app (protected from uninstall). */
function isSystem(appId: string): boolean {
  const target = normalizeId(appId);
  return installedApps().some((a) => normalizeId(a.id) === target && a.kind === 'system');
}

function markInstalledSignal(app: { id: string; name: string }, installed: boolean): void {
  if (installed) {
    if (!installedApps().some((a) => sameAppId(a.id, app.id))) {
      setInstalledApps([...installedApps(), { id: app.id, name: app.name }]);
    }
  } else {
    setInstalledApps(installedApps().filter((a) => !sameAppId(a.id, app.id)));
  }
  setMarketApps(marketApps().map((m) => (sameAppId(m.id, app.id) ? { ...m, installed } : m)));
}

export function setDomain(nextDomain: string): void {
  const d = normalizeDomain(nextDomain);
  setApiBase(d);
  if (d) void storage.save(STORAGE_DOMAIN_KEY, d);
  setStatus(d ? `Domain set: ${d}` : 'Domain cleared');
}

/**
 * The full card list: every marketplace app, plus apps installed locally that the
 * marketplace has never seen. The latter are what a developer publishes for the
 * first time — without them the UI could show sign-in but never a first Publish.
 */
function displayApps(): DisplayApp[] {
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
function visibleApps(): DisplayApp[] {
  const apps = displayApps();
  return hideInstalled() ? apps.filter((a) => !a.installed) : apps;
}

// ── Async action runner ──────────────────────────────────────────────────────

/**
 * Run an async action with loading state and unified error handling.
 * Sets status to `loadingMsg` before starting; on failure prefixes
 * the error with `errorPrefix`.
 */
async function runAction(
  loadingMsg: string,
  action: () => Promise<void>,
  errorPrefix: string,
): Promise<void> {
  setLoading(true);
  setStatus(loadingMsg, false);
  try {
    await action();
  } catch (err: unknown) {
    setStatus(`${errorPrefix}: ${errMsg(err)}`);
  } finally {
    setLoading(false);
  }
}

// ── Network helpers ──────────────────────────────────────────────────────────

async function apiGet<T>(path: string): Promise<T> {
  const base = apiBase();
  if (!base) throw new Error('No domain configured. Set a domain first.');
  const res = await fetch(`${base}${path}`, { method: 'GET' });
  if (!res.ok) throw new Error(`GET ${path} failed (${res.status})`);
  return res.json() as Promise<T>;
}

// ── Host verb helpers ────────────────────────────────────────────────────────

/** Install an app via yaar://apps/{appId}. Requires yaar://apps/ permission. */
async function hostInstall(app: { id: string }): Promise<void> {
  await invoke('yaar://apps/' + app.id, { action: 'install' });
}

/** Delete an app via yaar://apps/{appId}. Requires yaar://apps/ permission. */
async function hostDelete(app: { id: string }): Promise<void> {
  await del('yaar://apps/' + app.id);
}

/** Fetch installed apps via yaar://apps list verb. Requires yaar://apps/ permission. */
async function hostListInstalled(): Promise<InstalledApp[]> {
  const result = await list('yaar://apps');
  return parseInstalledAny(result);
}

// ── Account / publisher sign-in ────────────────────────────────────────────────
//
// These hit YAAR's *own* origin (relative paths), not the marketplace domain — the
// fetch proxy attaches this app's iframe token automatically, and the server only
// answers because market-apps is a bundled system app. `login` opens a real Google
// consent screen, which is why the routes are closed to ordinary apps.

async function yaarGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { method: 'GET' });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || `GET ${path} failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

async function yaarPost<T>(path: string): Promise<T> {
  const res = await fetch(path, { method: 'POST' });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || `POST ${path} failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

/** Pull sign-in status + owned apps from the server into the `account` signal. */
export async function refreshAccount(): Promise<void> {
  try {
    const status = await yaarGet<{
      configured: boolean;
      signedIn: boolean;
      email: string | null;
      pending: boolean;
    }>('/api/auth/google/status');

    let ownedApps: string[] = [];
    let email = status.email;
    if (status.signedIn) {
      // Best-effort: the marketplace may be unreachable — keep the local status either way.
      try {
        const me = await yaarGet<{ email: string | null; apps: string[] }>('/api/auth/google/me');
        ownedApps = Array.isArray(me.apps) ? me.apps : [];
        email = me.email ?? status.email;
      } catch {
        /* keep local status; owned apps unknown */
      }
    }

    setAccount({
      configured: status.configured,
      signedIn: status.signedIn,
      email,
      pending: status.pending,
      ownedApps,
    });
  } catch {
    // Not a system app, or the route is unavailable — leave the signed-out default.
    setAccount(SIGNED_OUT_ACCOUNT);
  }
}

/**
 * Start Google sign-in, then poll status until the browser round-trip finishes.
 *
 * Sign-in is a human gesture (agents publish against the already-signed-in
 * identity, they don't summon consent), so it lives on a button here and reports
 * back by polling rather than by holding the request open across the consent screen.
 */
export async function signIn(): Promise<void> {
  if (authBusy()) return;
  setAuthBusy(true);
  try {
    await yaarPost<{ authUrl: string }>('/api/auth/google/login');
    setStatus('Complete sign-in in the browser window that just opened…', false);

    for (let i = 0; i < 150; i++) {
      // ~5 min ceiling at 2s
      await new Promise((r) => setTimeout(r, 2000));
      await refreshAccount();
      const a = account();
      if (a.signedIn) {
        setStatus(`Signed in as ${a.email}`);
        return;
      }
      if (!a.pending) break; // the pending login was cancelled or swept
    }
    if (!account().signedIn) setStatus('Sign-in did not complete. Try again.');
  } catch (err: unknown) {
    setStatus(`Sign-in failed: ${errMsg(err)}`);
  } finally {
    setAuthBusy(false);
  }
}

export async function signOut(): Promise<void> {
  if (authBusy()) return;
  setAuthBusy(true);
  try {
    await yaarPost('/api/auth/google/logout');
    await refreshAccount();
    setStatus('Signed out');
  } catch (err: unknown) {
    setStatus(`Sign-out failed: ${errMsg(err)}`);
  } finally {
    setAuthBusy(false);
  }
}

/** Whether the signed-in publisher owns this app id (per the marketplace). */
function ownsApp(appId: string): boolean {
  const target = normalizeId(appId);
  return account().ownedApps.some((id) => normalizeId(id) === target);
}

/** Publish a locally installed app to the marketplace via the apps verb. */
async function publishApp(app: { id: string; name: string }): Promise<void> {
  await runAction(
    `Publishing ${app.name}…`,
    async () => {
      const result = (await invoke('yaar://apps/' + app.id, { action: 'publish' })) as {
        message?: string;
      };
      setStatus(result?.message || `Published ${app.name}`);
      // Ownership may have just been claimed — refresh so the badge reflects it.
      await refreshAccount();
    },
    'Publish failed',
  );
}

// ── Business logic ───────────────────────────────────────────────────────────

export async function refreshData(): Promise<void> {
  if (!apiBase()) {
    setStatus('No domain configured. Use App Protocol command setDomain.', true);
    return;
  }
  await runAction(
    'Refreshing\u2026',
    async () => {
      const marketPayload = await apiGet<ApiPayload>('/api/apps/');
      const apps = parseMarket(marketPayload);

      try {
        const localInstalled = await hostListInstalled();
        setInstalledApps(localInstalled);
        setStatus(`Loaded ${apps.length} market / ${localInstalled.length} installed apps`);
      } catch {
        setInstalledApps([]);
        setStatus(`Loaded ${apps.length} market apps (installed list unavailable)`);
      }

      setMarketApps(apps.map((m) => ({ ...m, installed: hasInstalled(m.id) })));
    },
    'Refresh failed',
  );
}

async function installApp(app: ListedApp): Promise<void> {
  await runAction(
    `Installing ${app.name}\u2026`,
    async () => {
      await hostInstall(app);
      markInstalledSignal(app, true);
      setStatus(`Installed ${app.name}`);
    },
    'Install failed',
  );
}

async function uninstallApp(app: { id: string; name: string }): Promise<void> {
  await runAction(
    `Uninstalling ${app.name}\u2026`,
    async () => {
      await hostDelete(app);
      markInstalledSignal(app, false);
      setStatus(`Uninstalled ${app.name}`);
    },
    'Uninstall failed',
  );
}

// ── UI components ─────────────────────────────────────────────────────────────

/** Publish/Update button for an installed, non-system app \u2014 only when signed in. */
function publishButton(app: DisplayApp) {
  if (isSystem(app.id) || !account().signedIn) return '';
  return html`
    <button
      class="y-btn y-btn-sm publish-btn"
      disabled=${() => loading()}
      onClick=${() => void publishApp(app)}
    >
      ${() => (ownsApp(app.id) ? 'Update' : 'Publish')}
    </button>
  `;
}

/** Render a single app card with Install / Publish / Uninstall actions. */
function marketCard(app: DisplayApp) {
  const subtitle = app.notPublished
    ? 'Installed locally \u2022 not on marketplace'
    : [app.description, app.version ? `v${app.version}` : '', app.author || '']
        .filter(Boolean)
        .join(' \u2022 ');

  return html`
    <div class="y-card app-card">
      <div class="app-info">
        <div class="app-name">${app.name}</div>
        <div class="app-subtitle y-text-muted">${subtitle || app.id}</div>
      </div>
      <div class="app-actions">
        ${() => {
          const installed = app.installed || hasInstalled(app.id);
          if (installed && isSystem(app.id)) {
            return html`<span class="installed-badge">✓ Built-in</span>`;
          }
          if (installed) {
            return html`
              <span class="installed-badge">✓ Installed</span>
              ${publishButton(app)}
              <button
                class="y-btn y-btn-sm y-btn-danger uninstall-btn"
                disabled=${() => loading()}
                onClick=${() => void uninstallApp(app)}
              >
                Uninstall
              </button>
            `;
          }
          return html`
            <button
              class="y-btn y-btn-sm y-btn-primary"
              disabled=${() => loading()}
              onClick=${() => void installApp(app)}
            >
              Install
            </button>
          `;
        }}
      </div>
    </div>
  `;
}

/** The publisher sign-in bar between the header and the filter row. */
function accountBar() {
  return html`
    <div class="account-bar y-surface">
      ${() => {
        const a = account();
        if (!a.configured) {
          return html`<span class="account-info y-text-muted"
            >Google sign-in isn't configured on this server — set GOOGLE_CLIENT_ID/SECRET to
            publish.</span
          >`;
        }
        if (a.signedIn) {
          const owned = a.ownedApps.length;
          return html`
            <span class="account-info"
              >Signed in as <strong>${a.email}</strong>${owned
                ? html`<span class="y-text-muted"> • ${owned} owned</span>`
                : ''}</span
            >
            <button
              class="y-btn y-btn-sm y-btn-ghost"
              disabled=${() => authBusy()}
              onClick=${() => void signOut()}
            >
              Sign out
            </button>
          `;
        }
        return html`
          <span class="account-info y-text-muted">Not signed in — sign in to publish apps.</span>
          <button
            class="y-btn y-btn-sm y-btn-primary"
            disabled=${() => authBusy()}
            onClick=${() => void signIn()}
          >
            ${() => (authBusy() ? 'Signing in…' : 'Sign in with Google')}
          </button>
        `;
      }}
    </div>
  `;
}

// ── Mount reactive UI ────────────────────────────────────────────────────────

render(
  () => html`
    <div class="y-app">
      <!-- Header -->
      <div class="header-bar y-surface">
        <div class="header-left">
          <div class="header-title">🛒 Market Apps</div>
          <div class="header-status y-text-muted">
            ${() => statusText()}${() => (lastUpdated() ? ` \u2022 ${lastUpdated()}` : '')}
          </div>
          <div class="header-domain y-text-dim">
            ${() => (apiBase() ? `Domain: ${apiBase()}` : 'Domain: (not set)')}
          </div>
        </div>
        <button
          class="y-btn y-btn-primary refresh-btn"
          disabled=${() => loading()}
          onClick=${() => void refreshData()}
        >
          ${() => (loading() ? 'Refreshing\u2026' : '\u21BB Refresh')}
        </button>
      </div>

      <!-- Publisher sign-in -->
      ${accountBar()}

      <!-- Filter bar -->
      <div class="filter-bar y-surface">
        <label class="filter-toggle">
          <input
            type="checkbox"
            checked=${() => hideInstalled()}
            onChange=${(e: Event) => setHideInstalled((e.target as HTMLInputElement).checked)}
          />
          Hide installed apps
        </label>
        <span class="filter-count y-text-muted">
          ${() => {
            const total = displayApps().length;
            const visible = visibleApps().length;
            const installed = installedApps().length;
            if (!total) return 'No apps loaded';
            return hideInstalled()
              ? `${visible} of ${total} apps \u2022 ${installed} installed`
              : `${total} apps \u2022 ${installed} installed`;
          }}
        </span>
      </div>

      <!-- App list -->
      <div class="y-scroll list-grid">
        ${() => {
          const apps = visibleApps();
          if (!apps.length) {
            const msg = displayApps().length
              ? 'All apps are already installed.'
              : 'No marketplace apps loaded.';
            return html`<div class="empty-msg y-text-muted">${msg}</div>`;
          }
          return apps.map((app) => marketCard(app));
        }}
      </div>
    </div>
  `,
  document.getElementById('app')!,
);

// ── Async initialization ─────────────────────────────────────────────────────

onMount(async () => {
  let domain = normalizeDomain(
    new URLSearchParams(window.location.search).get('domain') ||
      ((window as any).__MARKET_APPS_DOMAIN__ as string | undefined) ||
      '',
  );

  if (!domain) {
    try {
      const saved = await storage.read(STORAGE_DOMAIN_KEY);
      if (typeof saved === 'string' && saved.trim()) domain = normalizeDomain(saved.trim());
    } catch {
      // no saved domain
    }
  }

  if (!domain) domain = DEFAULT_MARKET_DOMAIN;
  setApiBase(domain);

  // Publisher sign-in is independent of the marketplace domain — load it either way.
  void refreshAccount();

  if (domain) {
    void refreshData();
  } else {
    setStatus('No domain configured. Set domain via App Protocol setDomain command.', true);
  }
});
