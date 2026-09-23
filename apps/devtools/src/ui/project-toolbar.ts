export {};
import { createSignal, onCleanup, For, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { app, errMsg, onShortcut, showConfirm, showToast, tryToast } from '@bundled/yaar';
import {
  activeProject,
  bundleStatus,
  projects,
  openTabs,
  previewUrl,
  type ProjectMeta,
} from '../core';
import { manifestString } from '../lib';
import {
  openProject,
  closeTab,
  compile,
  cloneApp,
  deploy,
  readFileText,
  listInstalledApps,
  type InstalledApp,
} from '../services';
import { Icon } from './icons';

// Project selection and build actions in the app chrome.
//
// The active project's name is the dropdown trigger: clicking it lists every open
// project, switches between them, and closes them.
//
// Load and Clone are their own buttons (hidden in a narrow window, where the menu's
// entries cover them) and open the filtered picker modal; the dropdown has no filter box.

type PickerMode = 'load' | 'clone';

const [picker, setPicker] = createSignal<PickerMode | null>(null);
const [filter, setFilter] = createSignal('');
const [installedApps, setInstalledApps] = createSignal<InstalledApp[]>([]);
const [appsError, setAppsError] = createSignal<string | null>(null);
const [busy, setBusy] = createSignal(false);
const [menuOpen, setMenuOpen] = createSignal(false);
const [deploying, setDeploying] = createSignal(false);

function closeMenu(): void {
  setMenuOpen(false);
}

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
  // Re-listed on every open rather than cached, so an app installed while this
  // window was up appears.
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

async function selectFromMenu(id: string): Promise<void> {
  closeMenu();
  if (activeProject()?.id === id) return;
  await tryToast(() => openProject(id));
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

async function deployFromToolbar(): Promise<void> {
  const appId = manifestString(await readFileText('app.json'), 'appId');
  if (!appId) {
    showToast('app.json has no appId to deploy under', 'error');
    return;
  }
  const confirmed = await showConfirm(`Deploy this project over the installed "${appId}"?`, {
    title: 'Deploy',
    okLabel: 'Deploy',
  });
  if (!confirmed) return;
  setDeploying(true);
  try {
    const result = await tryToast(() => deploy({ appId }));
    if (result) {
      const version = result.version ? ` v${result.version}` : '';
      const bumped = result.bumped ? ` (raised from ${result.bumped.from ?? 'none'})` : '';
      showToast(`Deployed "${result.name}"${version}${bumped}`, 'success', 5000);
    }
  } finally {
    setDeploying(false);
  }
}

/** The project name, doubling as the open-project menu. */
function ProjectMenu() {
  let root: HTMLElement | undefined;

  // Outside-click dismissal, decided by containment rather than by
  // stopPropagation inside the menu. Solid delegates click at the document, so a
  // handler that stops propagation cannot shield a *sibling* document listener
  // from the same event: the trigger would close the menu here and reopen it in
  // the same click. Asking "was the click inside this element" has no such
  // ordering problem.
  //
  // Capture phase, and that is load-bearing: Solid's delegated handler fires at
  // the document during the bubble phase and re-renders synchronously, so by the
  // time a bubble-phase listener saw the click on a project's close (×) button,
  // that button had already been detached and `contains` reported it as outside.
  // Capture runs while the target is still in the tree.
  const onDocumentClick = (event: MouseEvent) => {
    if (!menuOpen()) return;
    const target = event.target as Node | null;
    if (root && target && root.contains(target)) return;
    closeMenu();
  };
  document.addEventListener('click', onDocumentClick, true);
  onCleanup(() => document.removeEventListener('click', onDocumentClick, true));

  return html`
    <div class="project-menu" ref=${(el: HTMLElement) => (root = el)}>
      <button
        class=${() =>
          `project-menu-trigger${menuOpen() ? ' open' : ''}${activeProject() ? '' : ' empty'}`}
        title="Switch, load or clone a project"
        onClick=${() => setMenuOpen(!menuOpen())}
      >
        ${Icon('folder', 'project-menu-icon')}
        <span class="project-menu-name y-truncate"
          >${() => activeProject()?.name ?? 'No project open'}</span
        >
        ${Icon('chevron', 'project-menu-caret')}
      </button>

      <${Show} when=${menuOpen}>
        <div class="project-menu-panel">
          <div class="project-menu-section y-text-xs y-text-dim">Open projects</div>

          <${Show} when=${() => openTabs().length === 0}>
            <div class="project-menu-empty y-text-xs y-text-muted">
              No project open — use Load or Clone
            </div>
          <//>

          <${For} each=${openTabs}>
            ${(tabId: string) => {
              const project = () => projects().find((item) => item.id === tabId);
              const isActive = () => activeProject()?.id === tabId;
              return html`
                <div
                  class=${() => `project-menu-item${isActive() ? ' active' : ''}`}
                  onClick=${() => selectFromMenu(tabId)}
                >
                  <span class="project-menu-check">${() => (isActive() ? '✓' : '')}</span>
                  <span class="project-menu-label y-truncate"
                    >${() => project()?.name ?? tabId}</span
                  >
                  <span
                    class="project-menu-close"
                    title="Close project"
                    onClick=${(event: Event) => {
                      event.stopPropagation();
                      closeTab(tabId);
                    }}
                    >×</span
                  >
                </div>
              `;
            }}
          <//>

          <div class="project-menu-sep"></div>

          <div
            class="project-menu-item project-menu-action"
            onClick=${() => {
              closeMenu();
              openLoadPicker();
            }}
          >
            <span class="project-menu-check"></span>
            <span class="project-menu-label">Load project…</span>
          </div>

          <div
            class="project-menu-item project-menu-action"
            onClick=${() => {
              closeMenu();
              void openClonePicker();
            }}
          >
            <span class="project-menu-check"></span>
            <span class="project-menu-label">Clone installed app…</span>
          </div>
        </div>
      <//>
    </div>
  `;
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
                  class=${() => `picker-item${activeProject()?.id === project.id ? ' active' : ''}`}
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
  // Escape closes whichever surface is open, as it does for every other modal in
  // the shell. The guards matter: the handler is registered for the toolbar's whole
  // lifetime, so without them Escape would be swallowed while nothing is open.
  onCleanup(
    onShortcut('escape', () => {
      if (picker()) closePicker();
      else if (menuOpen()) closeMenu();
    }),
  );

  return html`
    <div class="y-toolbar y-toolbar-dense dt-toolbar">
      <${ProjectMenu} />

      <button
        class="y-btn y-btn-sm y-btn-ghost dt-btn toolbar-picker-btn"
        onClick=${openLoadPicker}
        title="Open an existing project"
      >
        ${Icon('folder')}
        <span class="dt-btn-label">Load</span>
      </button>

      <button
        class="y-btn y-btn-sm y-btn-ghost dt-btn toolbar-picker-btn"
        disabled=${busy}
        onClick=${openClonePicker}
        title="Clone an installed app's source into an editable project"
      >
        ${Icon('copy')}
        <span class="dt-btn-label">Clone</span>
      </button>

      <span class="toolbar-gap"></span>

      <button
        class="y-btn y-btn-sm y-btn-primary dt-btn"
        disabled=${() => !activeProject() || bundleStatus() === 'compiling'}
        onClick=${() => compile()}
        title="Type check and build"
      >
        ${Icon('code')}
        <span class="dt-btn-label"
          >${() => (bundleStatus() === 'compiling' ? 'Compiling…' : 'Compile')}</span
        >
      </button>

      <button
        class="y-btn y-btn-sm dt-btn"
        disabled=${() => !activeProject() || !previewUrl()}
        onClick=${requestPreview}
        title="Open preview window"
      >
        ${Icon('eye')}
        <span class="dt-btn-label">Preview</span>
      </button>

      <span class="dt-tsep"></span>

      <button
        class="y-btn y-btn-sm dt-btn"
        disabled=${() => !activeProject() || deploying()}
        onClick=${deployFromToolbar}
        title="Deploy this project over the installed app"
      >
        ${Icon('upload')}
        <span class="dt-btn-label">${() => (deploying() ? 'Deploying…' : 'Deploy')}</span>
      </button>

      <${Show} when=${picker}>
        <${PickerModal} />
      <//>
    </div>
  `;
}
