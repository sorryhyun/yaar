// ── App Protocol registration ───────────────────────────────────────────────────────
//
// All postMessage / App Protocol wiring lives here so that src/main.ts stays
// focused on UI.  The compiler auto-extracts the protocol manifest from this
// file and embeds it into app.json at deploy time.

import { app } from '@bundled/yaar';
import {
  marketApps,
  setMarketApps,
  installedApps,
  setInstalledApps,
  statusText,
  lastUpdated,
  loading,
  apiBase,
  hideInstalled,
  setHideInstalled,
  setDomain,
  setStatus,
  touch,
  refreshData,
  type ListedApp,
  type InstalledApp,
} from './main.js';

if (app) {
  app.register({
    appId: 'market-apps',
    name: 'Market Apps',
    state: {
      marketApps: {
        description: 'Current marketplace app list',
        handler: () => [...marketApps()],
      },
      installedApps: {
        description: 'Current installed app list',
        handler: () => [...installedApps()],
      },
      status: {
        description: 'Status line text',
        handler: () => statusText(),
      },
      lastUpdated: {
        description: 'Last updated local timestamp',
        handler: () => lastUpdated(),
      },
      domain: {
        description: 'Configured marketplace domain',
        handler: () => apiBase(),
      },
      loading: {
        description: 'Whether network request is in progress',
        handler: () => loading(),
      },
      hideInstalled: {
        description: 'Whether the Hide Installed filter is active',
        handler: () => hideInstalled(),
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
          return { ok: true, domain: apiBase() };
        },
      },
      refresh: {
        description: 'Fetch data from configured domain',
        params: { type: 'object', properties: {} },
        handler: async () => {
          await refreshData();
          return { ok: true, marketCount: marketApps().length, installedCount: installedApps().length };
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
          if (p.marketApps) setMarketApps(p.marketApps);
          if (p.installedApps) setInstalledApps(p.installedApps);
          if (p.status) setStatus(p.status);
          else touch();
          return { ok: true, marketCount: marketApps().length, installedCount: installedApps().length };
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
          return { ok: true };
        },
      },
      setHideInstalled: {
        description: 'Toggle the Hide Installed filter on or off',
        params: {
          type: 'object',
          properties: { hide: { type: 'boolean' } },
          required: ['hide'],
        },
        handler: (p: { hide: boolean }) => {
          setHideInstalled(p.hide);
          return { ok: true, hideInstalled: hideInstalled() };
        },
      },
      clearData: {
        description: 'Clear all app data',
        params: { type: 'object', properties: {} },
        handler: () => {
          setMarketApps([]);
          setInstalledApps([]);
          setStatus('Cleared');
          return { ok: true };
        },
      },
    },
  });
}
