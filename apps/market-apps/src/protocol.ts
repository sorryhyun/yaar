// ── App Protocol registration ───────────────────────────────────────────────────────
//
// All postMessage / App Protocol wiring lives here so that src/main.ts stays
// focused on UI.  The compiler auto-extracts the protocol manifest from this
// file and embeds it into app.json at deploy time.

import { app, defineCommand } from '@bundled/yaar';
import {
  marketApps,
  setMarketApps,
  installedApps,
  setInstalledApps,
  statusText,
  lastUpdated,
  loading,
  hideInstalled,
  setHideInstalled,
  search,
  setSearch,
  searchMode,
  setSearchMode,
  setStatus,
  touch,
} from './store.js';
import type { SearchMode } from './store.js';
import { refreshData } from './actions.js';

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
      loading: {
        description: 'Whether network request is in progress',
        handler: () => loading(),
      },
      hideInstalled: {
        description: 'Whether the Hide Installed filter is active',
        handler: () => hideInstalled(),
      },
      search: {
        description: 'Current search query filtering the app list by name and description',
        handler: () => search(),
      },
      searchMode: {
        description:
          "Which field the search filters on: 'title', 'author', or 'official' (YAAR-only view)",
        handler: () => searchMode(),
      },
    },
    commands: {
      refresh: defineCommand({
        description: 'Fetch the marketplace catalog and the installed-app list',
        params: { type: 'object', properties: {} },
        handler: async () => {
          await refreshData();
          return { marketCount: marketApps().length, installedCount: installedApps().length };
        },
      }),
      setData: defineCommand({
        description: 'Set marketplace and installed data manually',
        params: {
          type: 'object',
          properties: {
            marketApps: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  description: { type: 'string' },
                  version: { type: 'string' },
                  author: { type: 'string' },
                  icon: { type: 'string' },
                  installed: { type: 'boolean' },
                },
                required: ['id', 'name'],
              },
            },
            installedApps: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  hasSkill: { type: 'boolean' },
                  kind: { type: 'string' },
                  version: { type: 'string' },
                },
                required: ['id', 'name'],
              },
            },
            status: { type: 'string' },
          },
        },
        handler: (p) => {
          if (p.marketApps) setMarketApps(p.marketApps);
          if (p.installedApps) setInstalledApps(p.installedApps);
          if (p.status) setStatus(p.status);
          else touch();
          return { marketCount: marketApps().length, installedCount: installedApps().length };
        },
      }),
      setStatus: defineCommand({
        description: 'Update status line',
        params: {
          type: 'object',
          properties: { status: { type: 'string' } },
          required: ['status'],
        },
        handler: (p) => {
          setStatus(p.status);
        },
      }),
      setHideInstalled: defineCommand({
        description: 'Toggle the Hide Installed filter on or off',
        params: {
          type: 'object',
          properties: { hide: { type: 'boolean' } },
          required: ['hide'],
        },
        handler: (p) => {
          setHideInstalled(p.hide);
          return { hideInstalled: hideInstalled() };
        },
      }),
      setSearch: defineCommand({
        description: 'Set the search query that filters the app list by name and description',
        params: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
        handler: (p) => {
          setSearch(p.query);
          return { search: search() };
        },
      }),
      setSearchMode: defineCommand({
        description:
          "Set the search mode: 'title' (name/description), 'author', or 'official' (YAAR-only)",
        params: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['title', 'author', 'official'] },
          },
          required: ['mode'],
        },
        handler: (p) => {
          setSearchMode(p.mode as SearchMode);
          return { searchMode: searchMode() };
        },
      }),
      clearData: defineCommand({
        description: 'Clear all app data',
        params: { type: 'object', properties: {} },
        handler: () => {
          setMarketApps([]);
          setInstalledApps([]);
          setStatus('Cleared');
        },
      }),
    },
  });
}
