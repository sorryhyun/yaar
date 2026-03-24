export {};
import { createSignal, onMount } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import { invoke, del, listJson, storage, errMsg } from '@bundled/yaar';
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
  const id = firstString(obj.id, obj.appId, obj.slug, obj.packageName);
  if (!id) return null;
  const name = firstString(obj.name, obj.title) ?? id;
  return { id, name };
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
    const candidate =
      Array.isArray(obj.apps) ? obj.apps
      : Array.isArray(obj.installed) ? obj.installed
      : Array.isArray(obj.installedApps) ? obj.installedApps
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

/** Apps visible after applying the Hide Installed filter. */
function visibleApps(): ListedApp[] {
  const apps = marketApps();
  return hideInstalled() ? apps.filter((a) => !a.installed && !hasInstalled(a.id)) : apps;
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

/** Install an app via yaar://market/{appId}. Requires yaar://market permission. */
async function hostInstall(app: { id: string }): Promise<void> {
  await invoke('yaar://market/' + app.id, { action: 'install' });
}

/** Delete an app via yaar://apps/{appId}. Requires yaar://apps/ permission. */
async function hostDelete(app: { id: string }): Promise<void> {
  await del('yaar://apps/' + app.id);
}

/** Fetch installed apps via yaar://apps list verb. Requires yaar://apps/ permission. */
async function hostListInstalled(): Promise<InstalledApp[]> {
  const result = await listJson('yaar://apps');
  return parseInstalledAny(result);
}

// ── Business logic ───────────────────────────────────────────────────────────

export async function refreshData(): Promise<void> {
  if (!apiBase()) {
    setStatus('No domain configured. Use App Protocol command setDomain.', true);
    return;
  }
  await runAction('Refreshing\u2026', async () => {
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
  }, 'Refresh failed');
}

async function installApp(app: ListedApp): Promise<void> {
  await runAction(`Installing ${app.name}\u2026`, async () => {
    await hostInstall(app);
    markInstalledSignal(app, true);
    setStatus(`Installed ${app.name}`);
  }, 'Install failed');
}

async function uninstallApp(app: { id: string; name: string }): Promise<void> {
  await runAction(`Uninstalling ${app.name}\u2026`, async () => {
    await hostDelete(app);
    markInstalledSignal(app, false);
    setStatus(`Uninstalled ${app.name}`);
  }, 'Uninstall failed');
}

// ── UI components ─────────────────────────────────────────────────────────────

/** Render a single marketplace app card with Install / Uninstall actions. */
function marketCard(app: ListedApp) {
  const subtitle = [app.description, app.version ? `v${app.version}` : '', app.author || '']
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
          if (installed) {
            return html`
              <span class="installed-badge">\u2713 Installed</span>
              <button
                class="y-btn y-btn-sm y-btn-danger uninstall-btn"
                disabled=${loading()}
                onClick=${() => void uninstallApp(app)}
              >Uninstall</button>
            `;
          }
          return html`
            <button
              class="y-btn y-btn-sm y-btn-primary"
              disabled=${loading()}
              onClick=${() => void installApp(app)}
            >Install</button>
          `;
        }}
      </div>
    </div>
  `;
}

// ── Mount reactive UI ────────────────────────────────────────────────────────

render(() => html`
  <div class="y-app">

    <!-- Header -->
    <div class="header-bar y-surface">
      <div class="header-left">
        <div class="header-title">\uD83D\uDED2 Market Apps</div>
        <div class="header-status y-text-muted">
          ${() => statusText()}${() => lastUpdated() ? ` \u2022 ${lastUpdated()}` : ''}
        </div>
        <div class="header-domain y-text-dim">
          ${() => apiBase() ? `Domain: ${apiBase()}` : 'Domain: (not set)'}
        </div>
      </div>
      <button
        class="y-btn y-btn-primary refresh-btn"
        disabled=${() => loading()}
        onClick=${() => void refreshData()}
      >${() => loading() ? 'Refreshing\u2026' : '\u21BB Refresh'}</button>
    </div>

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
          const total = marketApps().length;
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
          const msg = marketApps().length
            ? 'All apps are already installed.'
            : 'No marketplace apps loaded.';
          return html`<div class="empty-msg y-text-muted">${msg}</div>`;
        }
        return apps.map((app) => marketCard(app));
      }}
    </div>

  </div>
`, document.getElementById('app')!);

// ── Async initialization ─────────────────────────────────────────────────────

onMount(async () => {
  let domain = normalizeDomain(
    new URLSearchParams(window.location.search).get('domain')
    || (window as any).__MARKET_APPS_DOMAIN__ as string | undefined
    || ''
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

  if (domain) {
    void refreshData();
  } else {
    setStatus('No domain configured. Set domain via App Protocol setDomain command.', true);
  }
});
