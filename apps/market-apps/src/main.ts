import { createSignal, onMount } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import { invoke, del, listJson, storage } from '@bundled/yaar';
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

export const [activeTab, setActiveTab] = createSignal<'market' | 'installed'>('market');
export const [marketApps, setMarketApps] = createSignal<ListedApp[]>([]);
export const [installedApps, setInstalledApps] = createSignal<InstalledApp[]>([]);
export const [statusText, setStatusText] = createSignal('Waiting for data…');
export const [lastUpdated, setLastUpdated] = createSignal('');
export const [loading, setLoading] = createSignal(false);
export const [apiBase, setApiBase] = createSignal('');

// ── Pure helper functions ────────────────────────────────────────────────────

function normalizeDomain(input?: string | null) {
  const value = (input || '').trim();
  if (!value) return '';
  return value.replace(/\/+$/, '');
}

function normalizeId(value: string) {
  return (value || '').trim().toLowerCase();
}

function sameAppId(a: string, b: string) {
  return normalizeId(a) === normalizeId(b);
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
  const lines = text.split(/\r?\n/);
  const result: InstalledApp[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*-\s+(.+?)\s+\(([^)]+)\)/);
    if (m) {
      result.push({ id: m[2].trim(), name: m[1].trim() });
    }
  }
  return result;
}

function coerceInstalledApp(input: any): InstalledApp | null {
  if (!input || typeof input !== 'object') return null;

  const id =
    typeof input.id === 'string'
      ? input.id
      : typeof input.appId === 'string'
      ? input.appId
      : typeof input.slug === 'string'
      ? input.slug
      : typeof input.packageName === 'string'
      ? input.packageName
      : null;

  if (!id) return null;

  const name =
    typeof input.name === 'string'
      ? input.name
      : typeof input.title === 'string'
      ? input.title
      : id;

  return { id, name };
}

function parseInstalledAny(input: any): InstalledApp[] {
  if (Array.isArray(input)) {
    return input.map(coerceInstalledApp).filter((a): a is InstalledApp => !!a);
  }

  if (typeof input === 'string') {
    return parseInstalledText(input);
  }

  if (input && typeof input === 'object') {
    const candidate =
      Array.isArray(input.apps)
        ? input.apps
        : Array.isArray(input.installed)
        ? input.installed
        : Array.isArray(input.installedApps)
        ? input.installedApps
        : [];

    if (candidate.length) {
      const parsed = candidate.map(coerceInstalledApp).filter((a): a is InstalledApp => !!a);
      if (parsed.length) return parsed;
    }

    if (typeof (input as any).text === 'string') {
      return parseInstalledText((input as any).text);
    }
  }

  return [];
}

// ── Signal-aware helpers ─────────────────────────────────────────────────────

function timeNow() {
  return new Date().toLocaleString();
}

export function touch() {
  setLastUpdated(timeNow());
}

export function setStatus(next: string, stamp = true) {
  setStatusText(next);
  if (stamp) touch();
}

function hasInstalled(appId: string) {
  const target = normalizeId(appId);
  return installedApps().some((a) => normalizeId(a.id) === target);
}

function markInstalledSignal(app: { id: string; name: string }, installed: boolean) {
  if (installed) {
    if (!installedApps().some((a) => sameAppId(a.id, app.id))) {
      setInstalledApps([...installedApps(), { id: app.id, name: app.name }]);
    }
  } else {
    setInstalledApps(installedApps().filter((a) => !sameAppId(a.id, app.id)));
  }
  setMarketApps(marketApps().map((m) => (sameAppId(m.id, app.id) ? { ...m, installed } : m)));
}

export function setDomain(nextDomain: string) {
  const d = normalizeDomain(nextDomain);
  setApiBase(d);
  if (d) void storage.save(STORAGE_DOMAIN_KEY, d);
  setStatus(d ? `Domain set: ${d}` : 'Domain cleared');
}

// ── Network helpers ──────────────────────────────────────────────────────────

async function apiGet<T>(path: string): Promise<T> {
  const base = apiBase();
  if (!base) throw new Error('No domain configured. Set a domain first.');
  const res = await fetch(`${base}${path}`, { method: 'GET' });
  if (!res.ok) throw new Error(`GET ${path} failed (${res.status})`);
  return res.json();
}

// ── Host verb helpers ────────────────────────────────────────────────────────

/**
 * Install an app by invoking yaar://market/{appId} with action:'install'.
 * Requires the yaar://market permission in app.json.
 */
async function hostInstall(app: { id: string; name: string }): Promise<void> {
  await invoke('yaar://market/' + app.id, { action: 'install' });
}

/**
 * Delete an app by calling del('yaar://apps/{appId}').
 * Requires the yaar://apps/ permission in app.json.
 */
async function hostDelete(app: { id: string; name: string }): Promise<void> {
  await del('yaar://apps/' + app.id);
}

/**
 * Fetch the list of installed apps via yaar://apps/ list verb.
 * Requires the yaar://apps/ permission in app.json.
 */
async function hostListInstalled(): Promise<InstalledApp[]> {
  const result = await listJson('yaar://apps');
  return parseInstalledAny(result);
}

// ── Business logic ───────────────────────────────────────────────────────────

export async function refreshData() {
  if (!apiBase()) {
    setStatus('No domain configured. Use App Protocol command setDomain.', true);
    return;
  }

  setLoading(true);
  setStatus('Refreshing…', false);

  try {
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
  } catch (err: any) {
    setStatus(`Refresh failed: ${err?.message || String(err)}`);
  } finally {
    setLoading(false);
  }
}

async function installApp(app: ListedApp) {
  try {
    setLoading(true);
    setStatus(`Installing ${app.name}…`, false);
    await hostInstall(app);
    markInstalledSignal(app, true);
    setStatus(`Installed ${app.name}`);
  } catch (err: any) {
    setStatus(`Install failed: ${err?.message || String(err)}`);
  } finally {
    setLoading(false);
  }
}

async function uninstallApp(app: InstalledApp) {
  try {
    setLoading(true);
    setStatus(`Uninstalling ${app.name}…`, false);
    await hostDelete(app);
    markInstalledSignal(app, false);
    setStatus(`Uninstalled ${app.name}`);
  } catch (err: any) {
    setStatus(`Uninstall failed: ${err?.message || String(err)}`);
  } finally {
    setLoading(false);
  }
}

// ── Card component ───────────────────────────────────────────────────────────

function card(title: string, subtitle: string, buttonLabel: string, onClick: () => void, disabled = false) {
  return html`
    <div class="y-card y-flex-between y-gap-2" style="min-height:88px">
      <div style="min-width:0;flex:1">
        <div style="font-weight:600">${title}</div>
        <div class="y-text-xs y-text-muted" style="margin-top:2px">${subtitle}</div>
      </div>
      <button
        class=${disabled ? 'y-btn y-btn-sm' : 'y-btn y-btn-sm y-btn-primary'}
        disabled=${disabled}
        onClick=${onClick}
      >${buttonLabel}</button>
    </div>
  `;
}

// ── Mount reactive UI ────────────────────────────────────────────────────────

render(() => html`
  <div class="y-app">
    <!-- Header -->
    <div class="y-flex-between y-gap-2 y-border-b y-surface" style="padding:14px 16px">
      <div>
        <div style="font-size:18px;font-weight:700">Market Apps</div>
        <div class="y-text-xs y-text-muted" style="margin-top:2px">
          ${() => statusText()}${() => lastUpdated() ? ` • ${lastUpdated()}` : ''}
        </div>
        <div class="y-text-xs y-text-dim" style="margin-top:4px">
          ${() => apiBase() ? `Domain: ${apiBase()}` : 'Domain: (not set)'}
        </div>
      </div>
      <button
        class="y-btn y-btn-sm y-btn-primary"
        disabled=${() => loading()}
        onClick=${() => void refreshData()}
      >${() => loading() ? 'Refreshing…' : 'Refresh'}</button>
    </div>

    <!-- Tabs -->
    <div class="y-flex y-gap-2 y-border-b y-surface" style="padding:10px 16px">
      <button
        class=${() => activeTab() === 'market' ? 'y-btn y-btn-sm y-btn-primary' : 'y-btn y-btn-sm'}
        onClick=${() => setActiveTab('market')}
      >${() => `Marketplace (${marketApps().length})`}</button>
      <button
        class=${() => activeTab() === 'installed' ? 'y-btn y-btn-sm y-btn-primary' : 'y-btn y-btn-sm'}
        onClick=${() => setActiveTab('installed')}
      >${() => `Installed (${installedApps().length})`}</button>
    </div>

    <!-- List -->
    <div class="y-scroll list-grid">
      ${() => {
        if (activeTab() === 'market') {
          const apps = marketApps();
          if (!apps.length) return html`<div class="y-text-muted">No marketplace apps loaded.</div>`;
          return apps.map((app) => {
            const subtitle = [app.description, app.version ? `v${app.version}` : '', app.author || '']
              .filter(Boolean)
              .join(' • ');
            const installed = app.installed || hasInstalled(app.id);
            return card(
              app.name,
              subtitle,
              installed ? 'Installed' : 'Install',
              () => void installApp(app),
              loading() || installed,
            );
          });
        } else {
          const apps = installedApps();
          if (!apps.length) return html`<div class="y-text-muted">No installed apps loaded.</div>`;
          return apps.map((app) =>
            card(app.name, app.id, 'Uninstall', () => void uninstallApp(app), loading()),
          );
        }
      }}
    </div>
  </div>
`, document.getElementById('app')!);

// ── Async initialization ─────────────────────────────────────────────────────

onMount(async () => {
  let domain = '';

  const fromQuery = new URLSearchParams(window.location.search).get('domain');
  const fromGlobal = (window as any).__MARKET_APPS_DOMAIN__ as string | undefined;
  domain = normalizeDomain(fromQuery || fromGlobal || '');

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
