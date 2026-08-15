import { onMount } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { defineApp } from '@bundled/yaar';
import './styles/index';
import { App } from './components.js';
import { refreshAccount, refreshData, startGithubStatusPolling } from './actions.js';
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

// Feeds the publish banner. Started here rather than inside `onMount` below
// because that callback is async: after its first `await`, Solid's owner is gone
// and an `onCleanup` registered there would never fire. Independent of both the
// marketplace domain and sign-in — an outage is worth flagging before the user
// gets that far. `pagehide` covers the window being closed; the interval dies
// with the iframe either way, so this is belt-and-braces.
const stopGithubStatusPolling = startGithubStatusPolling();
window.addEventListener('pagehide', stopGithubStatusPolling);

// Startup I/O hangs off `onMount` here rather than at module scope so it
// runs under the view's owner.
function Root() {
  onMount(() => {
    // Publisher sign-in and the catalog are independent — neither waits for the other.
    void refreshAccount();
    void refreshData();
  });
  return html`<${App} />`;
}

export default defineApp({
  id: 'market-apps',
  name: 'Market Apps',
  state: {
    marketApps: {
      description: 'Current marketplace app list',
      get: () => [...marketApps()],
    },
    installedApps: {
      description: 'Current installed app list',
      get: () => [...installedApps()],
    },
    status: {
      description: 'Status line text',
      get: () => statusText(),
    },
    lastUpdated: {
      description: 'Last updated local timestamp',
      get: () => lastUpdated(),
    },
    loading: {
      description: 'Whether network request is in progress',
      get: () => loading(),
    },
    hideInstalled: {
      description: 'Whether the Hide Installed filter is active',
      get: () => hideInstalled(),
    },
    search: {
      description: 'Current search query filtering the app list by name and description',
      get: () => search(),
    },
    searchMode: {
      description:
        "Which field the search filters on: 'title', 'author', or 'official' (YAAR-only view)",
      get: () => searchMode(),
    },
  },
  commands: {
    refresh: {
      description: 'Fetch the marketplace catalog and the installed-app list',
      params: { type: 'object', properties: {} },
      run: async () => {
        await refreshData();
        return { marketCount: marketApps().length, installedCount: installedApps().length };
      },
    },
    setData: {
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
                kind: { type: 'string' },
                version: { type: 'string' },
              },
              required: ['id', 'name'],
            },
          },
          status: { type: 'string' },
        },
      },
      run: (p) => {
        if (p.marketApps) setMarketApps(p.marketApps);
        if (p.installedApps) setInstalledApps(p.installedApps);
        if (p.status) setStatus(p.status);
        else touch();
        return { marketCount: marketApps().length, installedCount: installedApps().length };
      },
    },
    setStatus: {
      description: 'Update status line',
      params: {
        type: 'object',
        properties: { status: { type: 'string' } },
        required: ['status'],
      },
      run: (p) => {
        setStatus(p.status);
      },
    },
    setHideInstalled: {
      description: 'Toggle the Hide Installed filter on or off',
      params: {
        type: 'object',
        properties: { hide: { type: 'boolean' } },
        required: ['hide'],
      },
      run: (p) => {
        setHideInstalled(p.hide);
        return { hideInstalled: hideInstalled() };
      },
    },
    setSearch: {
      description: 'Set the search query that filters the app list by name and description',
      params: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
      run: (p) => {
        setSearch(p.query);
        return { search: search() };
      },
    },
    setSearchMode: {
      description:
        "Set the search mode: 'title' (name/description), 'author', or 'official' (YAAR-only)",
      params: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['title', 'author', 'official'] },
        },
        required: ['mode'],
      },
      run: (p) => {
        setSearchMode(p.mode as SearchMode);
        return { searchMode: searchMode() };
      },
    },
    clearData: {
      description: 'Clear all app data',
      params: { type: 'object', properties: {} },
      run: () => {
        setMarketApps([]);
        setInstalledApps([]);
        setStatus('Cleared');
      },
    },
  },
  view: Root,
});
