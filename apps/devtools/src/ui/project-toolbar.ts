export {};
import { createSignal, onCleanup, For, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { app, errMsg, onShortcut, tryToast } from '@bundled/yaar';
import { activeProject, projects, previewUrl, type ProjectMeta } from '../core';
import { openProject, compile, cloneApp, listInstalledApps, type InstalledApp } from '../services';

// Project selection and build actions in the app chrome.
//
// Four buttons and a label. Switching projects is Load, cloning one is Clone, and
// the name of whatever is open is text — not a `<select>`. The dropdown it replaces
// was doing three jobs badly: it reported the active project, it switched between
// projects, and its last entry ("+ New Project") performed an action rather than
// selecting one, which put a destructive-ish path one keystroke away from every
// project name. The picker does the switching, with a filter box the dropdown
// never had; ProjectTabs and the status bar report what is open.

type PickerMode = 'load' | 'clone';

const [picker, setPicker] = createSignal<PickerMode | null>(null);
const [filter, setFilter] = createSignal('');
const [installedApps, setInstalledApps] = createSignal<InstalledApp[]>([]);
const [appsError, setAppsError] = createSignal<string | null>(null);
const [busy, setBusy] = createSignal(false);

function closePicker(): void {
  setPicker(null);
  setFilter('');
}

function openLoadPicker(): void {
  setFilter('');
  setPicker('load');
}

async function openClonePicker(): Promise<void> {
  setFilter('');
  setPicker('clone');
  // Re-listed on every open rather than cached: an app installed from the
  // marketplace while this window was up is exactly the one being looked for.
  setBusy(true);
  setAppsError(null);
  try {
    setInstalledApps(await listInstalledApps());
  } catch (err) {
    // An empty list and "the listing failed" are different answers, and only one
    // of them means there is nothing to clone.
    setAppsError(errMsg(err));
    setInstalledApps([]);
  } finally {
    setBusy(false);
  }
}

const visibleProjects = () => {
  const needle = filter().trim().toLowerCase();
  const list = [...projects()].sort((a, b) => b.lastModified - a.lastModified);
  if (!needle) return list;
  return list.filter(
    (p) => p.name.toLowerCase().includes(needle) || p.id.toLowerCase().includes(needle),
  );
};

const visibleApps = () => {
  const needle = filter().trim().toLowerCase();
  if (!needle) return installedApps();
  return installedApps().filter(
    (a) =>
      a.name.toLowerCase().includes(needle) ||
      a.id.toLowerCase().includes(needle) ||
      (a.description ?? '').toLowerCase().includes(needle),
  );
};

async function chooseProject(id: string): Promise<void> {
  closePicker();
  await tryToast(() => openProject(id));
}

async function chooseApp(appId: string): Promise<void> {
  closePicker();
  setBusy(true);
  try {
    // A clone copies every file in the app and can take a moment; a failure has to
    // say so rather than leave the button stuck and the project list unchanged.
    await tryToast(() => cloneApp(appId), { success: `Cloned "${appId}"` });
  } finally {
    setBusy(false);
  }
}

function requestPreview(): void {
  const url = previewUrl();
  if (!url) return;
  app?.sendInteraction({
    event: 'preview_request',
    previewUrl: url,
    projectName: activeProject()?.name ?? 'Preview',
  });
}

function PickerModal() {
  return html`
    <div class="y-overlay picker-overlay" onClick=${closePicker}>
      <div class="y-modal picker-modal" onClick=${(e: Event) => e.stopPropagation()}>
        <div class="y-modal-title">
          ${() => (picker() === 'load' ? 'Load project' : 'Clone installed app')}
        </div>
        <input
          class="y-input picker-filter"
          placeholder=${() => (picker() === 'load' ? 'Filter projects…' : 'Filter apps…')}
          value=${filter}
          onInput=${(e: Event) => setFilter((e.target as HTMLInputElement).value)}
        />
        <div class="picker-list y-scroll">
          <${Show} when=${() => picker() === 'load'}>
            <${Show} when=${() => visibleProjects().length === 0}>
              <div class="picker-empty y-text-xs y-text-muted">No projects</div>
            <//>
            <${For} each=${visibleProjects}>
              ${(project: ProjectMeta) => html`
                <div
                  class=${() =>
                    `picker-item${activeProject()?.id === project.id ? ' active' : ''}`}
                  onClick=${() => chooseProject(project.id)}
                >
                  <span class="picker-name y-truncate">${project.name}</span>
                  <span class="picker-meta y-text-xs y-text-dim y-font-mono">${project.id}</span>
                </div>
              `}
            <//>
          <//>
          <${Show} when=${() => picker() === 'clone'}>
            <${Show} when=${appsError}>
              <div class="picker-empty y-text-xs" style="color: var(--yaar-error)">
                Could not list apps: ${appsError}
              </div>
            <//>
            <${Show} when=${() => !appsError() && busy() && installedApps().length === 0}>
              <div class="picker-empty y-text-xs y-text-muted">Loading installed apps…</div>
            <//>
            <${For} each=${visibleApps}>
              ${(item: InstalledApp) => html`
                <div class="picker-item" onClick=${() => chooseApp(item.id)}>
                  <span class="picker-name y-truncate">${item.name}</span>
                  <span class="picker-meta y-text-xs y-text-dim y-font-mono">${item.id}</span>
                  <${Show} when=${() => item.kind === 'system'}>
                    <span class="y-badge y-text-xs">system</span>
                  <//>
                </div>
              `}
            <//>
          <//>
        </div>
        <div class="y-modal-actions">
          <button class="y-btn y-btn-sm" onClick=${closePicker}>Cancel</button>
        </div>
      </div>
    </div>
  `;
}

export function ProjectToolbar() {
  // Escape closes the picker, as it does for every other modal in the shell. The
  // guard matters: the handler is registered for the toolbar's whole lifetime, so
  // without it Escape would be swallowed while nothing is open.
  onCleanup(
    onShortcut('escape', () => {
      if (picker()) closePicker();
    }),
  );

  return html`
    <div class="toolbar">
      <span
        class=${() =>
          `toolbar-project y-truncate${activeProject() ? '' : ' y-text-dim'}`}
        title=${() => activeProject()?.name ?? 'No project open'}
      >
        ${() => activeProject()?.name ?? 'No project open'}
      </span>

      <button
        class="y-btn y-btn-sm"
        onClick=${openLoadPicker}
        title="Open an existing project"
      >
        Load
      </button>

      <button
        class="y-btn y-btn-sm"
        disabled=${busy}
        onClick=${openClonePicker}
        title="Clone an installed app's source into an editable project"
      >
        Clone
      </button>

      <span class="toolbar-gap"></span>

      <button
        class="y-btn y-btn-sm y-btn-primary"
        disabled=${() => !activeProject()}
        onClick=${() => compile()}
        title="Compile"
      >
        Compile
      </button>

      <button
        class="y-btn y-btn-sm"
        disabled=${() => !activeProject() || !previewUrl()}
        onClick=${requestPreview}
        title="Open preview window"
      >
        Preview
      </button>

      <${Show} when=${picker}>
        <${PickerModal} />
      <//>
    </div>
  `;
}
