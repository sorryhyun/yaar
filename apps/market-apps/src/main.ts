type ListedApp = {
  id: string;
  name: string;
  description?: string;
  version?: string;
  author?: string;
  installed?: boolean;
};

type InstalledApp = {
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

const STORAGE_DOMAIN_KEY = 'market_apps.domain';
const DEFAULT_MARKET_DOMAIN = 'https://yaarmarket.vercel.app';

function normalizeDomain(input?: string | null) {
  const value = (input || '').trim();
  if (!value) return '';
  return value.replace(/\/+$/, '');
}

function getInitialDomain() {
  const fromQuery = new URLSearchParams(window.location.search).get('domain');
  const fromGlobal = (window as any).__MARKET_APPS_DOMAIN__ as string | undefined;
  const fromStorage = localStorage.getItem(STORAGE_DOMAIN_KEY);
  return normalizeDomain(fromQuery || fromGlobal || fromStorage || DEFAULT_MARKET_DOMAIN);
}

const root = document.createElement('div');
root.style.cssText = `
  font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: #0b1020;
  color: #e8ecff;
`;
document.body.style.margin = '0';
document.body.appendChild(root);

let activeTab: 'market' | 'installed' = 'market';
let marketApps: ListedApp[] = [];
let installedApps: InstalledApp[] = [];
let statusText = 'Waiting for data…';
let lastUpdated = '';
let loading = false;
let apiBase = getInitialDomain();

function timeNow() {
  return new Date().toLocaleString();
}

function touch() {
  lastUpdated = timeNow();
}

function setStatus(next: string, stamp = true) {
  statusText = next;
  if (stamp) touch();
}

function setDomain(nextDomain: string) {
  apiBase = normalizeDomain(nextDomain);
  if (apiBase) localStorage.setItem(STORAGE_DOMAIN_KEY, apiBase);
  else localStorage.removeItem(STORAGE_DOMAIN_KEY);
  setStatus(apiBase ? `Domain set: ${apiBase}` : 'Domain cleared');
  render();
}

async function apiGet<T>(path: string): Promise<T> {
  if (!apiBase) throw new Error('No domain configured. Set a domain first.');
  const res = await fetch(`${apiBase}${path}`, { method: 'GET' });
  if (!res.ok) throw new Error(`GET ${path} failed (${res.status})`);
  return res.json();
}

async function apiPost<T>(path: string, body: object): Promise<T> {
  if (!apiBase) throw new Error('No domain configured. Set a domain first.');
  const res = await fetch(`${apiBase}${path}`, {
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

function hasInstalled(appId: string) {
  return installedApps.some((a) => a.id === appId);
}

function markInstalled(app: { id: string; name: string }, installed: boolean) {
  if (installed) {
    if (!installedApps.some((a) => a.id === app.id)) {
      installedApps = [...installedApps, { id: app.id, name: app.name }];
    }
  } else {
    installedApps = installedApps.filter((a) => a.id !== app.id);
  }

  marketApps = marketApps.map((m) => (m.id === app.id ? { ...m, installed } : m));
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

  return null;
}

function parseMarket(payload: ApiPayload): ListedApp[] {
  return Array.isArray(payload.marketApps) ? payload.marketApps : Array.isArray(payload.apps) ? payload.apps : [];
}

function parseInstalled(payload: ApiPayload): InstalledApp[] {
  return Array.isArray(payload.installedApps)
    ? payload.installedApps
    : Array.isArray(payload.installed)
    ? payload.installed
    : [];
}

async function refreshData() {
  if (!apiBase) {
    setStatus('No domain configured. Use App Protocol command setDomain.', true);
    render();
    return;
  }

  loading = true;
  setStatus('Refreshing…', false);
  render();

  try {
    const marketPayload = await apiGet<ApiPayload>('/api/apps/');
    marketApps = parseMarket(marketPayload);

    try {
      const installedPayload = await apiGet<ApiPayload>('/api/installed');
      installedApps = parseInstalled(installedPayload);
      setStatus(`Loaded ${marketApps.length} market / ${installedApps.length} installed apps`);
    } catch (installedErr: any) {
      setStatus(`Loaded ${marketApps.length} market apps (no /api/installed endpoint)`);
    }

    marketApps = marketApps.map((m) => ({ ...m, installed: m.installed || hasInstalled(m.id) }));
  } catch (err: any) {
    setStatus(`Refresh failed: ${err?.message || String(err)}`);
  } finally {
    loading = false;
    render();
  }
}

async function installApp(app: ListedApp) {
  try {
    loading = true;
    setStatus(`Installing ${app.name}…`, false);
    render();

    const hostMode = await hostAction('install', app);
    if (hostMode === 'os-action') {
      markInstalled(app, true);
      setStatus(`Installed ${app.name} via OS action`);
      loading = false;
      render();
      return;
    }
    if (hostMode === 'interaction') {
      setStatus(`Install request sent for ${app.name} (waiting for agent)`);
      loading = false;
      render();
      return;
    }

    await apiPostAny(['/api/install', '/api/apps/install'], { appId: app.id });
    markInstalled(app, true);
    setStatus(`Installed ${app.name}`);
    loading = false;
    render();
  } catch (err: any) {
    loading = false;
    setStatus(`Install failed: ${err?.message || String(err)}`);
    render();
  }
}

async function uninstallApp(app: InstalledApp) {
  try {
    loading = true;
    setStatus(`Uninstalling ${app.name}…`, false);
    render();

    const hostMode = await hostAction('uninstall', app);
    if (hostMode === 'os-action') {
      markInstalled(app, false);
      setStatus(`Uninstalled ${app.name} via OS action`);
      loading = false;
      render();
      return;
    }
    if (hostMode === 'interaction') {
      setStatus(`Uninstall request sent for ${app.name} (waiting for agent)`);
      loading = false;
      render();
      return;
    }

    await apiPostAny(['/api/uninstall', '/api/apps/uninstall'], { appId: app.id });
    markInstalled(app, false);
    setStatus(`Uninstalled ${app.name}`);
    loading = false;
    render();
  } catch (err: any) {
    loading = false;
    setStatus(`Uninstall failed: ${err?.message || String(err)}`);
    render();
  }
}

function card(title: string, subtitle: string, buttonLabel: string, onClick: () => void, disabled = false) {
  const item = document.createElement('div');
  item.style.cssText = `
    border: 1px solid #263254;
    border-radius: 10px;
    padding: 12px;
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: center;
    background: #121a34;
  `;

  const left = document.createElement('div');
  const t = document.createElement('div');
  t.textContent = title;
  t.style.cssText = 'font-weight: 600;';
  const s = document.createElement('div');
  s.textContent = subtitle;
  s.style.cssText = 'opacity: 0.8; font-size: 12px; margin-top: 2px;';
  left.append(t, s);

  const btn = document.createElement('button');
  btn.textContent = buttonLabel;
  btn.disabled = disabled;
  btn.style.cssText = `
    border: 1px solid #3c4d84;
    background: ${disabled ? '#18213f' : '#1f2b54'};
    color: #e8ecff;
    border-radius: 8px;
    padding: 8px 12px;
    cursor: ${disabled ? 'not-allowed' : 'pointer'};
    opacity: ${disabled ? 0.7 : 1};
  `;
  btn.onclick = onClick;

  item.append(left, btn);
  return item;
}

function render() {
  root.innerHTML = '';

  const header = document.createElement('div');
  header.style.cssText = 'padding: 14px 16px; border-bottom: 1px solid #263254; display: flex; justify-content: space-between; align-items: center; gap: 10px;';

  const titleWrap = document.createElement('div');
  const title = document.createElement('div');
  title.textContent = 'Market Apps';
  title.style.cssText = 'font-size: 18px; font-weight: 700;';
  const meta = document.createElement('div');
  meta.textContent = `${statusText}${lastUpdated ? ` • ${lastUpdated}` : ''}`;
  meta.style.cssText = 'font-size: 12px; opacity: 0.8; margin-top: 2px;';
  const domain = document.createElement('div');
  domain.textContent = apiBase ? `Domain: ${apiBase}` : 'Domain: (not set)';
  domain.style.cssText = 'font-size: 11px; opacity: 0.7; margin-top: 4px;';
  titleWrap.append(title, meta, domain);

  const refresh = document.createElement('button');
  refresh.textContent = loading ? 'Refreshing…' : 'Refresh';
  refresh.disabled = loading;
  refresh.style.cssText = 'border: 1px solid #3c4d84; background: #1f2b54; color: #e8ecff; border-radius: 8px; padding: 8px 12px; cursor: pointer;';
  refresh.onclick = () => {
    void refreshData();
  };

  header.append(titleWrap, refresh);

  const tabs = document.createElement('div');
  tabs.style.cssText = 'display: flex; gap: 8px; padding: 10px 16px; border-bottom: 1px solid #263254;';

  const mk = document.createElement('button');
  mk.textContent = `Marketplace (${marketApps.length})`;
  const ins = document.createElement('button');
  ins.textContent = `Installed (${installedApps.length})`;

  [mk, ins].forEach((b) => {
    b.style.cssText = 'border: 1px solid #3c4d84; background: #1a2445; color: #e8ecff; border-radius: 999px; padding: 6px 12px; cursor: pointer;';
  });
  if (activeTab === 'market') mk.style.background = '#2f4fd1';
  if (activeTab === 'installed') ins.style.background = '#2f4fd1';

  mk.onclick = () => {
    activeTab = 'market';
    render();
  };
  ins.onclick = () => {
    activeTab = 'installed';
    render();
  };
  tabs.append(mk, ins);

  const list = document.createElement('div');
  list.style.cssText = 'padding: 14px 16px; overflow: auto; display: grid; gap: 10px;';

  if (activeTab === 'market') {
    if (!marketApps.length) {
      const empty = document.createElement('div');
      empty.textContent = 'No marketplace apps loaded.';
      empty.style.opacity = '0.8';
      list.appendChild(empty);
    } else {
      for (const app of marketApps) {
        const subtitle = [app.description, app.version ? `v${app.version}` : '', app.author || ''].filter(Boolean).join(' • ');
        const installed = app.installed || hasInstalled(app.id);
        list.appendChild(card(app.name, subtitle, installed ? 'Reinstall' : 'Install', () => void installApp(app), loading));
      }
    }
  } else {
    if (!installedApps.length) {
      const empty = document.createElement('div');
      empty.textContent = 'No installed apps loaded.';
      empty.style.opacity = '0.8';
      list.appendChild(empty);
    } else {
      for (const app of installedApps) {
        list.appendChild(card(app.name, app.id, 'Uninstall', () => void uninstallApp(app), loading));
      }
    }
  }

  root.append(header, tabs, list);
}

render();

const appApi = (window as any).yaar?.app;
if (appApi) {
  appApi.register({
    appId: 'market-apps',
    name: 'Market Apps',
    state: {
      marketApps: {
        description: 'Current marketplace app list',
        handler: () => [...marketApps],
      },
      installedApps: {
        description: 'Current installed app list',
        handler: () => [...installedApps],
      },
      status: {
        description: 'Status line text',
        handler: () => statusText,
      },
      lastUpdated: {
        description: 'Last updated local timestamp',
        handler: () => lastUpdated,
      },
      domain: {
        description: 'Configured marketplace domain',
        handler: () => apiBase,
      },
      loading: {
        description: 'Whether network request is in progress',
        handler: () => loading,
      },
    },
    commands: {
      setDomain: {
        description: 'Set marketplace API domain (e.g. https://example.com)',
        params: {
          type: 'object',
          properties: {
            domain: { type: 'string' },
            autoRefresh: { type: 'boolean' },
          },
          required: ['domain'],
        },
        handler: async (p: { domain: string; autoRefresh?: boolean }) => {
          setDomain(p.domain);
          if (p.autoRefresh !== false) await refreshData();
          return { ok: true, domain: apiBase };
        },
      },
      refresh: {
        description: 'Fetch data from configured domain',
        params: { type: 'object', properties: {} },
        handler: async () => {
          await refreshData();
          return { ok: true, marketCount: marketApps.length, installedCount: installedApps.length };
        },
      },
      setData: {
        description: 'Set marketplace and installed data manually',
        params: {
          type: 'object',
          properties: {
            marketApps: { type: 'array', items: { type: 'object' } },
            installedApps: { type: 'array', items: { type: 'object' } },
            status: { type: 'string' },
          },
        },
        handler: (p: { marketApps?: ListedApp[]; installedApps?: InstalledApp[]; status?: string }) => {
          if (p.marketApps) marketApps = p.marketApps;
          if (p.installedApps) installedApps = p.installedApps;
          if (p.status) statusText = p.status;
          touch();
          render();
          return { ok: true, marketCount: marketApps.length, installedCount: installedApps.length };
        },
      },
      setStatus: {
        description: 'Update status line',
        params: {
          type: 'object',
          properties: { status: { type: 'string' } },
          required: ['status'],
        },
        handler: (p: { status: string }) => {
          setStatus(p.status);
          render();
          return { ok: true };
        },
      },
      clearData: {
        description: 'Clear all app data',
        params: { type: 'object', properties: {} },
        handler: () => {
          marketApps = [];
          installedApps = [];
          setStatus('Cleared');
          render();
          return { ok: true };
        },
      },
    },
  });
}

if (apiBase) {
  void refreshData();
} else {
  setStatus('No domain configured. Set domain via App Protocol setDomain command.', true);
  render();
}
