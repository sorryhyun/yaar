// Entry point: the view and the agent-facing protocol.
//
//   store.ts  signals, the installed-app list, the published history (appDb)
//   build.ts  clone an app's source into projects/<appId>/ and compile it

import { For, Show, onMount } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { AppCommandError, app, defineApp, errMsg, showToast } from '@bundled/yaar';
import * as z from '@bundled/zod';
import { BuildError, buildApp, type PageAsset } from './build';
import {
  activity,
  apps,
  failure,
  forgetPublished,
  history,
  publishedFor,
  refreshApps,
  savePublished,
  selected,
  setActivity,
  setFailure,
  setSelected,
  startStep,
  type AppEntry,
  type Published,
} from './store';
import './styles.css';

const STEP_LABEL = {
  cloning: 'Cloning source',
  compiling: 'Compiling',
  publishing: 'Waiting for the agent to publish',
} as const;

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** The button: build here, then hand the compiled file to the agent to publish. */
async function buildAndPublish(appId: string): Promise<void> {
  let path: string;
  let assets: PageAsset[];
  try {
    ({ path, assets } = await buildApp(appId));
  } catch {
    // buildApp has already put the messages in `failure`, which the view shows.
    return;
  }
  const prior = publishedFor(appId);
  startStep(appId, 'publishing');
  app.sendInteraction({
    instructions: prior
      ? `Republish the compiled "${appId}" at "${path}" (this app's storage) to its existing Claude Artifact, then call recordPublished.`
      : `Publish the compiled "${appId}" at "${path}" (this app's storage) as a Claude Artifact, then call recordPublished.`,
    appId,
    path,
    ...(assets.length ? { assets } : {}),
    ...(prior ? { previousUrl: prior.url } : {}),
  });
}

/** Only the agent holds the Artifact tool, so it is the one that can tell a deleted link. */
function verifyLinks(): void {
  const links = history().map((h) => ({ appId: h.appId, url: h.url }));
  if (!links.length) return;
  app.sendInteraction({
    instructions:
      'Check that each published Artifact link still exists on claude.ai, and call forgetPublished for each one that was deleted.',
    links,
  });
  showToast('Asked the agent to check the links', 'info');
}

function App() {
  onMount(() => {
    void refreshApps().catch((e) => showToast(`Could not list apps: ${errMsg(e)}`, 'error'));
  });

  const building = () => {
    const step = activity()?.step;
    return step === 'cloning' || step === 'compiling';
  };

  return html`
    <div class="y-app ap-root">
      <div class="y-toolbar">
        <span class="y-font-bold">Artifact Publisher</span>
        <span class="ap-grow"></span>
        <button class="y-btn y-btn-sm y-btn-ghost" onClick=${() => void refreshApps()}>
          Refresh
        </button>
      </div>

      <div class="ap-main">
        <section class="ap-pane">
          <div class="y-label ap-pane-head">Installed apps</div>
          <div class="y-scroll ap-pane-body">
            <${For}
              each=${apps}
              fallback=${html`<div class="y-empty"><div>No apps listed.</div></div>`}
            >
              ${(a: AppEntry) => html`
                <div
                  class="y-list-item"
                  classList=${() => ({ active: selected() === a.id })}
                  onClick=${() => setSelected(a.id)}
                  title=${a.description}
                >
                  <span class="ap-grow y-truncate">${a.name}</span>
                  <${Show} when=${() => publishedFor(a.id)}>
                    <span class="y-badge y-badge-success">published</span>
                  </${Show}>
                  <span class="y-text-xs y-text-muted y-font-mono">${a.id}</span>
                </div>
              `}
            </${For}>
          </div>

          <${Show} when=${() => failure()}>
            <div class="ap-failure y-wash-error y-border-t">
              <div class="ap-failure-head">
                <span class="y-font-bold">
                  ${() => `${failure()?.stage === 'build' ? 'Build' : 'Publish'} failed: ${failure()?.appId}`}
                </span>
                <button class="y-btn y-btn-sm y-btn-ghost" onClick=${() => setFailure(null)}>
                  Dismiss
                </button>
              </div>
              <pre class="ap-failure-body y-font-mono y-scroll">${() =>
                failure()?.messages.join('\n')}</pre>
            </div>
          </${Show}>

          <div class="ap-actions y-border-t">
            <${Show} when=${() => activity()} fallback=${html`<span class="ap-grow"></span>`}>
              <span class="y-spinner"></span>
              <span class="ap-grow y-truncate y-text-sm y-text-muted">
                ${() => {
                  const a = activity();
                  return a ? `${STEP_LABEL[a.step]}: ${a.appId}…` : '';
                }}
              </span>
            </${Show}>
            <button
              class="y-btn y-btn-primary"
              disabled=${() => !selected() || building()}
              onClick=${() => {
                const id = selected();
                if (id) void buildAndPublish(id);
              }}
            >
              Build & Publish
            </button>
          </div>
        </section>

        <section class="ap-pane">
          <div class="ap-pane-head ap-pane-head-row">
            <span class="y-label ap-grow">Published</span>
            <button
              class="y-btn y-btn-sm y-btn-ghost"
              disabled=${() => !history().length}
              title="Ask the agent which links were deleted on claude.ai"
              onClick=${verifyLinks}
            >
              Verify
            </button>
          </div>
          <div class="y-scroll ap-pane-body">
            <${For}
              each=${history}
              fallback=${html`<div class="y-empty"><div>Nothing published yet.</div></div>`}
            >
              ${(h: Published) => html`
                <div class="ap-history-row y-border-b">
                  <div class="ap-history-head">
                    <span class="ap-grow y-font-bold y-truncate">${h.title}</span>
                    <button
                      class="y-btn y-btn-sm y-btn-ghost"
                      title="Drop this row, e.g. after deleting the Artifact on claude.ai. Deletes nothing there"
                      onClick=${() =>
                        void forgetPublished(h.appId).catch((e) =>
                          showToast(`Could not forget ${h.appId}: ${errMsg(e)}`, 'error'),
                        )}
                    >
                      Forget
                    </button>
                  </div>
                  <a class="ap-link y-text-sm y-truncate" href=${h.url}>${h.url}</a>
                  <div class="y-text-xs y-text-muted y-truncate">
                    <span class="y-font-mono">${h.appId}</span> · ${formatTime(h.publishedAt)}
                  </div>
                </div>
              `}
            </${For}>
          </div>
        </section>
      </div>
    </div>
  `;
}

export default defineApp({
  id: 'artifact-publisher',
  name: 'Artifact Publisher',
  // State is restored from appDb and shared signals on remount; a replay would rebuild
  // an app or re-record a publish nobody asked for again.
  replay: 'never',
  state: {
    apps: {
      description: 'Installed apps that can be built: [{ id, name, description, version }]',
      get: () => apps(),
    },
    selected: {
      description: 'App id the user has selected, or null',
      get: () => selected(),
    },
    activity: {
      description:
        'The build or publish in flight ({ appId, step: cloning|compiling|publishing, since }), or null. A "publishing" step waits on recordPublished or publishFailed',
      get: () => activity(),
    },
    failure: {
      description:
        'The last failed build or publish ({ appId, stage, messages }) shown to the user, or null',
      get: () => failure(),
    },
    published: {
      description:
        'Publish history, newest first: [{ appId, path, url, title, publishedAt }], one row per app. An app listed here already has an Artifact URL',
      get: () => history(),
    },
  },
  commands: {
    refresh: {
      description: 'Re-list the installed apps and return them',
      params: z.object({}),
      run: async () => ({ apps: await refreshApps() }),
    },
    build: {
      description:
        "Clone an installed app's source into this app's storage and compile it. Returns { path, assets, warnings }: the compiled page and the files to publish beside it (assets: [{ path, publishedAs, contentType }]), paths relative to this app's storage root. Compile errors are thrown and shown to the user",
      params: z.object({ appId: z.string() }),
      run: async (p) => {
        setSelected(p.appId);
        try {
          return await buildApp(p.appId);
        } catch (e) {
          throw new AppCommandError(
            e instanceof BuildError ? `Build failed:\n${e.messages.join('\n')}` : errMsg(e),
          );
        }
      },
    },
    recordPublished: {
      description:
        'Record a successful publish: adds or updates the history row for `appId` and clears the in-flight state',
      params: z.object({
        appId: z.string(),
        path: z.string(),
        url: z.string(),
        title: z.optional(z.string()),
      }),
      run: async (p) => {
        if (!/^https:\/\//.test(p.url)) {
          throw new AppCommandError('url must be the https URL the Artifact tool returned');
        }
        const result = await savePublished({
          appId: p.appId,
          path: p.path,
          url: p.url,
          title: p.title ?? p.appId,
          publishedAt: new Date().toISOString(),
        });
        if (activity()?.appId === p.appId) setActivity(null);
        if (failure()?.appId === p.appId) setFailure(null);
        showToast(result.updated ? `Updated ${p.appId}` : `Published ${p.appId}`, 'success');
        return result;
      },
    },
    forgetPublished: {
      description:
        'Drop the history row for `appId`, for an Artifact deleted on claude.ai: the app shows as unpublished again and its next publish creates a new Artifact. Deletes nothing on claude.ai',
      params: z.object({ appId: z.string() }),
      run: async (p) => ({ removed: await forgetPublished(p.appId) }),
    },
    publishFailed: {
      description:
        'Report that a publish could not be done (Artifact tool missing, file unreadable, refused); shown to the user, clears the in-flight state',
      params: z.object({ appId: z.string(), reason: z.string() }),
      run: (p) => {
        if (activity()?.appId === p.appId) setActivity(null);
        setFailure({ appId: p.appId, stage: 'publish', messages: [p.reason] });
        return { ok: true };
      },
    },
  },
  view: App,
});
