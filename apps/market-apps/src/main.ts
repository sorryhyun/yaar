import { onMount } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { defineApp } from '@bundled/yaar';
import './styles/index';
import { App } from './components/index.js';
import {
  refreshAccount,
  publishForAgent,
  refreshData,
  startGithubStatusPolling,
  startPublishAll,
  updateAllApps,
  waitForPublishRun,
} from './actions/index.js';
import {
  marketApps,
  setMarketApps,
  installedApps,
  setInstalledApps,
  installedVersionOf,
  outdatedApps,
  updateRun,
  lastPublish,
  publishRun,
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
  setSharedCatalog,
  setSharedStatus,
  setSharedFilters,
} from './store/index.js';
import type { SearchMode } from './store/index.js';

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
    outdatedApps: {
      description:
        'Installed apps whose marketplace version is newer than the local one — what updateAll installs',
      get: () =>
        outdatedApps().map((a) => ({
          id: a.id,
          name: a.name,
          installedVersion: installedVersionOf(a.id) ?? null,
          marketVersion: a.version ?? null,
        })),
    },
    updateRun: {
      description:
        'Progress of the running or last-finished updateAll: active, total, completed, current app, and a per-app result list',
      get: () => {
        const run = updateRun();
        return { ...run, results: [...run.results] };
      },
    },
    lastPublish: {
      description:
        'Result of the last publish to settle (a `publish` command or one app of a publishAll run), or null: appId, published, status, message, version, artifactSha256, byteLength, changedFiles (on drift), finishedAt',
      get: () => lastPublish(),
    },
    publishRun: {
      description:
        'Progress of the running or last-finished publishAll: active, total, completed (apps attempted), current appId, results [{ appId, version, published, status, message, finishedAt }] in request order, stopped ({ appId, status, message } when the run ended early, else null), startedAt, finishedAt. Apps the run never reached are listed with status "skipped".',
      get: () => {
        const run = publishRun();
        return { ...run, results: [...run.results] };
      },
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
        // Written unconditionally, even for a call that only patches one array —
        // the shared payload is the full pair, and a follower has no other way to
        // reconstruct data that came from the agent rather than the host.
        setSharedCatalog({ marketApps: marketApps(), installedApps: installedApps() });
        if (p.status) setSharedStatus(p.status);
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
        setSharedStatus(p.status);
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
        setSharedFilters({
          hideInstalled: hideInstalled(),
          search: search(),
          searchMode: searchMode(),
        });
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
        setSharedFilters({
          hideInstalled: hideInstalled(),
          search: search(),
          searchMode: searchMode(),
        });
        return { search: search() };
      },
    },
    setSearchMode: {
      description:
        "Set the search mode: 'title' (name/description), 'author', or 'official' (YAAR-only)",
      // The enum repeats SEARCH_MODES (store/signals.ts) as a literal because the
      // protocol extractor reads this object statically — it cannot follow an import.
      params: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['title', 'author', 'official'] },
        },
        required: ['mode'],
      },
      run: (p) => {
        setSearchMode(p.mode as SearchMode);
        setSharedFilters({
          hideInstalled: hideInstalled(),
          search: search(),
          searchMode: searchMode(),
        });
        return { searchMode: searchMode() };
      },
    },
    updateAll: {
      description:
        'Install the marketplace version of every app in `outdatedApps`, one at a time. A failing app is recorded in the results and the run continues. Refused while a run is already in flight, and when nothing is outdated.',
      params: {
        type: 'object',
        properties: {
          confirm: {
            type: 'boolean',
            description:
              'Ask the user to approve the batch first, as the header button does. Off by default: updating replaces each installed copy on disk.',
          },
        },
      },
      run: (p) => updateAllApps({ confirm: p.confirm === true }),
    },
    publish: {
      description:
        "Publish an installed app's local copy to the marketplace as the signed-in publisher, without the dialog: the host packages apps/{appId} at its app.json version and uploads it. Returns { published, status, message, ... } rather than throwing; fails when no publisher is signed in, the version is not newer than the published one, the publisher has not accepted the Publisher Terms in the dialog, or another publish or publishAll run is in progress (status busy). Routinely takes over 30s — call it with timeoutMs of at least 120000, or a still-running publish reads as a timeout. For more than one app use publishAll.",
      params: {
        type: 'object',
        properties: {
          appId: { type: 'string', description: 'Id of the installed app to publish.' },
          expectedVersion: {
            type: 'string',
            description:
              'Refuse with status version_mismatch unless the packaged app.json version is exactly this — pins the publish to the build just deployed.',
          },
        },
        required: ['appId'],
      },
      run: (p) => publishForAgent({ appId: p.appId, expectedVersion: p.expectedVersion }),
    },
    publishAll: {
      description:
        'Start publishing several installed apps one at a time, in order, and return at once with { started, total } — the results are NOT in this reply: block on `waitPublish` or read `publishRun`. Each app is the `publish` command; one refusal (version_mismatch, not newer, drift) is recorded and the run continues, but terms_required or no signed-in publisher stops it and marks the rest skipped. Returns { started: false, status: "busy" } while any publish, run or publish dialog is in progress.',
      replay: 'never',
      params: {
        type: 'object',
        properties: {
          apps: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              properties: {
                appId: { type: 'string', description: 'Id of the installed app to publish.' },
                expectedVersion: {
                  type: 'string',
                  description:
                    'Record version_mismatch for this app (and move on) unless its packaged app.json version is exactly this.',
                },
              },
              required: ['appId'],
            },
          },
        },
        required: ['apps'],
      },
      run: (p) => startPublishAll(p.apps),
    },
    waitPublish: {
      description:
        "Block until the publishAll run finishes or timeoutMs passes, then return `publishRun` plus { done, timedOut }. Answers at once when no run is active. Raise the call's own timeout above timeoutMs; on timedOut just call it again.",
      params: {
        type: 'object',
        properties: {
          timeoutMs: {
            type: 'number',
            description:
              'How long to wait, in ms (default 25000, max 600000). The default fits the 30s default command timeout.',
          },
        },
      },
      run: (p) =>
        waitForPublishRun(
          Math.min(Math.max(typeof p.timeoutMs === 'number' ? p.timeoutMs : 25_000, 0), 600_000),
        ),
    },
    clearData: {
      description: 'Clear all app data',
      params: { type: 'object', properties: {} },
      run: () => {
        setMarketApps([]);
        setInstalledApps([]);
        setStatus('Cleared');
        setSharedCatalog({ marketApps: [], installedApps: [] });
        setSharedStatus('Cleared');
      },
    },
  },
  view: Root,
});
