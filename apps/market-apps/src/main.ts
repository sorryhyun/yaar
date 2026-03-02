import { signal, html, mount, onMount } from '@bundled/yaar';
import './styles.css';
import './protocol.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type ListedApp = {
  id: string;
  name: string;
  description?: string;
  version?: string;
  author?: string;
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

export const activeTab = signal<'market' | 'installed'>('market');
export const marketApps = signal<ListedApp[]>([]);
export const installedApps = signal<InstalledApp[]>([]);
export const statusText = signal('Waiting for data…');
export const lastUpdated = signal('');
export const loading = signal(false);
export const apiBase = signal('');

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

function parseInstalled(payload: ApiPayload): InstalledApp[] {
  return Array.isArray(payload.installedApps)
    ? payload.installedApps
    : Array.isArray(payload.installed)
    ? payload.installed
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
  lastUpdated(timeNow());
}

export function setStatus(next: string, stamp = true) {
  statusText(next);
  if (stamp) touch();
}

function hasInstalled(appId: string) {
  const target = normalizeId(appId);
  return installedApps().some((a) => normalizeId(a.id) === target);
}

function markInstalledSignal(app: { id: string; name: string }, installed: boolean) {
  if (installed) {
    if (!installedApps().some((a) => sameAppId(a.id, app.id))) {
      installedApps([...installedApps(), { id: app.id, name: app.name }]);
    }
  } else {
    installedApps(installedApps().filter((a) => !sameAppId(a.id, app.id)));
  }
  marketApps(marketApps().map((m) => (sameAppId(m.id, app.id) ? { ...m, installed } : m)));
}

export function setDomain(nextDomain: string) {
  const d = normalizeDomain(nextDomain);
  apiBase(d);
  const storage = (window as any).yaar?.storage;
  if (storage) {
    if (d) void storage.save(STORAGE_DOMAIN_KEY, d);
  }
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

async function apiPost<T>(path: string, body: object): Promise<T> {
  const base = apiBase();
  if (!base) throw new Error('No domain configured. Set a domain first.');
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} failed (${res.status})`);
  return res.json();
}

async function apiPostAny<T>(paths: string[], body: object): Promise<T> {
  let lastErr: any;
  for (const path of paths) {
    try {
      return await apiPost<T>(path, body);
    } catch (err: any) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('All POST endpoints failed');
}

async function getInstalledFromLocalApi(): Promise<InstalledApp[]> {
  const candidates = ['/api/apps', '/api/apps/list', '/api/apps/installed', '/api/installed'];
  for (const path of candidates) {
    try {
      const res = await fetch(path, { method: 'GET' });
      if (!res.ok) continue;

      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      if (contentType.includes('application/json')) {
        const payload = await res.json();
        const parsed = parseInstalledAny(payload);
        if (parsed.length) return parsed;
      } else {
        const text = await res.text();
        const parsed = parseInstalledAny(text);
        if (parsed.length) return parsed;
      }
    } catch {
      // ignore and try next endpoint
    }
  }
  return [];
}

async function hostAction(action: 'install' | 'uninstall', app: { id: string; name: string }) {
  const yaarAny = (window as any).yaar;

  if (typeof yaarAny?.os?.action === 'function') {
    const toolName = action === 'install' ? 'apps:market_get' : 'apps:market_delete';
    await yaarAny.os.action(toolName, { appId: app.id });
    return 'os-action' as const;
  }

  if (typeof yaarAny?.app?.sendInteraction === 'function') {
    yaarAny.app.sendInteraction({
      event: 'market-apps:request',
      action,
      appId: app.id,
      appName: app.name,
      requestedAt: new Date().toISOString(),
    });
    return 'interaction' as const;
  }

  throw new Error('Host install/uninstall API is unavailable.');
}

// ── Business logic ───────────────────────────────────────────────────────────

export async function refreshData() {
  if (!apiBase()) {
    setStatus('No domain configured. Use App Protocol command setDomain.', true);
    return;
  }

  loading(true);
  setStatus('Refreshing…', false);

  try {
    const marketPayload = await apiGet<ApiPayload>('/api/apps/');
    const apps = parseMarket(marketPayload);

    const yaarAny = (window as any).yaar;
    if (typeof yaarAny?.os?.action === 'function') {
      try {
        const localInstalled = await yaarAny.os.action('apps:list', {});
        installedApps(parseInstalledAny(localInstalled));
        setStatus(`Loaded ${apps.length} market / ${installedApps().length} installed apps (apps:list)`);
      } catch {
        installedApps([]);
        setStatus(`Loaded ${apps.length} market / ${installedApps().length} installed apps`);
      }
    } else {
      const localApiInstalled = await getInstalledFromLocalApi();
      installedApps(localApiInstalled);
      setStatus(`Loaded ${apps.length} market / ${installedApps().length} installed apps`);
    }

    marketApps(apps.map((m) => ({ ...m, installed: hasInstalled(m.id) })));
  } catch (err: any) {
    setStatus(`Refresh failed: ${err?.message || String(err)}`);
  } finally {
    loading(false);
  }
}

async function installApp(app: ListedApp) {
  try {
    loading(true);
    setStatus(`Installing ${app.name}…`, false);

    const hostMode = await hostAction('install', app);
    if (hostMode === 'os-action') {
      markInstalledSignal(app, true);
      setStatus(`Installed ${app.name} via apps:market_get`);
      loading(false);
      return;
    }

    setStatus(`Install request sent for ${app.name} (waiting for agent)`);
    loading(false);
  } catch (err: any) {
    loading(false);
    setStatus(`Install failed: ${err?.message || String(err)}`);
  }
}

async function uninstallApp(app: InstalledApp) {
  try {
    loading(true);
    setStatus(`Uninstalling ${app.name}…`, false);

    const hostMode = await hostAction('uninstall', app);
    if (hostMode === 'os-action') {
      markInstalledSignal(app, false);
      setStatus(`Uninstalled ${app.name} via apps:market_delete`);
      loading(false);
      return;
    }

    setStatus(`Uninstall request sent for ${app.name} (waiting for agent)`);
    loading(false);
  } catch (err: any) {
    loading(false);
    setStatus(`Uninstall failed: ${err?.message || String(err)}`);
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

mount(html`
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
        onClick=${() => activeTab('market')}
      >${() => `Marketplace (${marketApps().length})`}</button>
      <button
        class=${() => activeTab() === 'installed' ? 'y-btn y-btn-sm y-btn-primary' : 'y-btn y-btn-sm'}
        onClick=${() => activeTab('installed')}
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
`);

// ── Async initialization ─────────────────────────────────────────────────────

onMount(async () => {
  const storage = (window as any).yaar?.storage;
  let domain = '';

  const fromQuery = new URLSearchParams(window.location.search).get('domain');
  const fromGlobal = (window as any).__MARKET_APPS_DOMAIN__ as string | undefined;
  domain = normalizeDomain(fromQuery || fromGlobal || '');

  if (!domain && storage) {
    try {
      const saved = await storage.read(STORAGE_DOMAIN_KEY, { as: 'text' });
      if (typeof saved === 'string' && saved.trim()) domain = normalizeDomain(saved.trim());
    } catch {
      // no saved domain
    }
  }

  if (!domain) domain = DEFAULT_MARKET_DOMAIN;
  apiBase(domain);

  if (domain) {
    void refreshData();
  } else {
    setStatus('No domain configured. Set domain via App Protocol setDomain command.', true);
  }
});
