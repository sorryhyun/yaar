export {};
import { For, Show, onMount } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import './styles.css';
import type { StorageEntry } from './types';
import { state, setState, setElMountAlias, setElMountHostPath, setElMountReadonly, setElPreviewBody } from './state';
import { basename, formatSize, getFileIcon, sanitizeAlias } from './helpers';
import { handleDragStart, handleDragEnd, requestOpenByAgent } from './drag';
import { openMountDialog, closeMountDialog, submitMountRequest } from './mount-dialog';
import { navigate, selectFile, closePreview } from './navigation';
import {
  panelWidth,
  setPanelWidth,
  resetPanelWidth,
  reclampPanelWidth,
  maxPanelWidth,
  MIN_PANEL_WIDTH,
  DEFAULT_PANEL_WIDTH,
} from './layout';
import {
  navOpen,
  navPinned,
  openNav,
  closeNav,
  scheduleNavClose,
  toggleNavPin,
  setNavPin,
  setNavResizing,
} from './navOverlay';
import { app, storage, showToast, showConfirm, defineApp } from '@bundled/yaar';

// ── Upload ──────────────────────────────────────────────────────

let uploadInput: HTMLInputElement;

function openUploadDialog() {
  uploadInput?.click();
}

async function handleUpload(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  if (!files.length) return;
  setState('statusText', `Uploading ${files.length} file(s)…`);
  try {
    for (const file of files) {
      const path = state.currentPath ? `${state.currentPath}/${file.name}` : file.name;
      const buf = await file.arrayBuffer();
      await storage.save(path, buf);
    }
    input.value = '';
    navigate(state.currentPath);
    showToast(`Uploaded ${files.length} file${files.length !== 1 ? 's' : ''}`, 'success');
  } catch {
    setState('statusText', 'Upload failed');
    showToast('Upload failed', 'error');
  }
}

// ── Panel width drag ────────────────────────────────────────────────

// The panel is pinned to left:0, so the pointer's clientX *is* the desired
// width — setPanelWidth applies the min/max clamp. Pointer capture keeps the
// stream flowing when the cursor outruns the handle.
function startResize(e: PointerEvent) {
  e.preventDefault();
  const handle = e.currentTarget as HTMLElement;
  handle.setPointerCapture(e.pointerId);
  setNavResizing(true);
  document.body.classList.add('nav-resizing');

  const onMove = (ev: PointerEvent) => setPanelWidth(ev.clientX);
  const onUp = (ev: PointerEvent) => {
    handle.releasePointerCapture(ev.pointerId);
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onUp);
    handle.removeEventListener('pointercancel', onUp);
    document.body.classList.remove('nav-resizing');
    setNavResizing(false);
    openNav();
  };

  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onUp);
}

// Keep the panel width within 70% of the window as it shrinks.
window.addEventListener('resize', () => reclampPanelWidth());

// ── Template ──────────────────────────────────────────────

const App = () => {
  onMount(() => {
    navigate('');
  });

  return html`
  <!-- Full-window background: the file preview, or a hint when nothing is open -->
  <div class="bg-layer">
    <div class=${() => `preview${state.showPreview ? '' : ' hidden'}`}>
      <div class="y-label preview-header y-flex-between">
        <span class="y-truncate">${() => state.previewTitleText}</span>
        <button class="preview-close" onClick=${closePreview} title="Close preview">✕</button>
      </div>
      <div class="preview-body" ref=${(el: HTMLDivElement) => { setElPreviewBody(el); }}></div>
      <div class="preview-meta y-text-xs y-text-muted">${() => state.previewMetaText}</div>
    </div>

    <${Show} when=${() => !state.showPreview}>
      <div class="bg-empty">
        <div class="bg-empty-icon">🗂️</div>
        <div class="bg-empty-title">Storage</div>
        <div class="bg-empty-hint">Hover the left edge to browse files, then pick a file to preview it here.</div>
        <div class="bg-empty-path y-text-xs y-text-muted">${() => 'yaar://storage/' + (state.currentPath || '')}</div>
      </div>
    <//>
  </div>

  <!-- Left hover-open overlay: toolbar + directory listing -->
  <div class="y-nav-root">
    <div class="y-nav-hover-zone" onMouseEnter=${openNav} onMouseLeave=${scheduleNavClose}></div>

    <button
      class=${() =>
        'y-nav-hamburger' +
        (navPinned() ? ' y-nav-hamburger-pinned' : '') +
        (navOpen() ? ' y-nav-hamburger-hidden' : '')}
      onClick=${() => toggleNavPin()}
      title="Files (click to pin open)"
    >☰</button>

    <div
      class=${() => 'y-nav-panel' + (navOpen() ? ' y-nav-panel-open' : '')}
      style=${() => '--panel-w:' + panelWidth() + 'px'}
      onMouseEnter=${openNav}
      onMouseLeave=${scheduleNavClose}
    >
      <div class="y-nav-header">
        <span class="y-nav-title">FILES <span class="y-nav-count">${() => state.entries.length}</span></span>
        <button
          class=${() => 'y-nav-pin' + (navPinned() ? ' y-nav-pin-active' : '')}
          onClick=${() => toggleNavPin()}
          title=${() => (navPinned() ? 'Unpin panel' : 'Pin panel open')}
        >📌</button>
      </div>

      <div class="nav-panel-controls">
        <div class="breadcrumb">
          ${() => {
            const parts = state.currentPath ? state.currentPath.split('/').filter(Boolean) : [];
            const crumbs: any[] = [
              html`<button onClick=${() => navigate('')}>yaar://storage/</button>`
            ];
            let accumulated = '';
            for (const part of parts) {
              accumulated += (accumulated ? '/' : '') + part;
              const p = accumulated;
              crumbs.push(html`<span class="sep">/</span>`);
              crumbs.push(html`<button onClick=${() => navigate(p)}>${part}</button>`);
            }
            return crumbs;
          }}
        </div>
        <div class="toolbar-actions">
          <select class="toolbar-select" title="Jump to mounted folder"
            onChange=${(e: Event) => {
              const val = (e.target as HTMLSelectElement).value;
              if (!val) return;
              navigate(`mounts/${val}`);
              (e.target as HTMLSelectElement).value = '';
            }}>
            <option value="">Mounts</option>
            <${For} each=${() => state.mountAliases}>
              ${(alias: string) => html`<option value="${alias}">${alias}</option>`}
            <//>
          </select>
          <button class="toolbar-btn y-btn y-btn-sm" onClick=${openMountDialog} title="Request mount folder">Mount…</button>
          <button class="toolbar-btn y-btn y-btn-sm" onClick=${() => navigate(state.currentPath)} title="Refresh">↻</button>
          <button class="toolbar-btn y-btn y-btn-sm" onClick=${openUploadDialog} title="Upload files">⬆ Upload</button>
          <input type="file" id="upload-input" multiple style="display:none"
            ref=${(el: HTMLInputElement) => { uploadInput = el; }}
            onChange=${handleUpload} />
        </div>
      </div>

      <div class="file-list y-scroll">
        ${() => {
          const list = state.entries;
          if (list.length === 0) return html`<div class="y-empty empty">This folder is empty</div>`;
          return html`
            <${For} each=${() => state.entries}>
              ${(entry: StorageEntry) => {
                const name = basename(entry.path);
                return html`
                  <div
                    class=${() => `file-row${state.selectedFile === entry.path ? ' selected' : ''}`}
                    draggable="true"
                    onClick=${(e: MouseEvent) => {
                      if ((e.target as HTMLElement).closest('.file-actions')) return;
                      if (entry.isDirectory) navigate(entry.path);
                      else selectFile(entry);
                    }}
                    onDblclick=${(e: MouseEvent) => {
                      if ((e.target as HTMLElement).closest('.file-actions')) return;
                      if (!entry.isDirectory) requestOpenByAgent(entry);
                    }}
                    onDragstart=${(e: DragEvent) => handleDragStart(e, entry)}
                    onDragend=${(e: DragEvent) => handleDragEnd(e)}
                  >
                    <span class="file-icon">${getFileIcon(name, entry.isDirectory)}</span>
                    <span class=${`file-name${entry.isDirectory ? ' dir' : ''}`}>${name}</span>
                    <span class="file-size">${entry.isDirectory ? '' : formatSize(entry.size)}</span>
                    <span class="file-actions">
                      <${Show} when=${() => !entry.isDirectory}>
                        <button title="Open in new tab" onClick=${(e: MouseEvent) => {
                          e.stopPropagation();
                          window.open(storage.url(entry.path), '_blank');
                        }}>⇗</button>
                      <//>
                      <button class="danger" title="Delete" onClick=${async (e: MouseEvent) => {
                        e.stopPropagation();
                        if (!(await showConfirm(`Delete "${name}"?`, { danger: true, okLabel: 'Delete' }))) return;
                        try {
                          await storage.remove(entry.path);
                          navigate(state.currentPath);
                        } catch {
                          setState('statusText', `Failed to delete ${name}`);
                        }
                      }}>🗑</button>
                    </span>
                  </div>
                `;
              }}
            <//>
          `;
        }}
      </div>

      <div class="y-statusbar">${() => state.statusText}</div>

      <div
        class="y-nav-resizer"
        onPointerDown=${startResize}
        onDblClick=${() => resetPanelWidth()}
        title="Drag to resize (double-click: reset)"
      ></div>
    </div>
  </div>

  <${Show} when=${() => state.showModal}>
    <div class="y-overlay" onClick=${(e: MouseEvent) => {
      if (e.target === e.currentTarget) closeMountDialog();
    }}>
      <div class="y-modal">
        <div class="y-modal-title">Request Host Folder Mount</div>
        <div class="y-modal-msg">The app cannot mount folders directly. Submit a request and the agent will ask for permission and run the mount tool.</div>
        <form class="modal-form" onSubmit=${submitMountRequest}>
          <label class="modal-label y-text-xs y-text-muted">Mount alias</label>
          <input class="modal-input y-input" name="alias" placeholder="project-files" required
            ref=${(el: HTMLInputElement) => { setElMountAlias(el); }} />
          <label class="modal-label y-text-xs y-text-muted">Host folder path</label>
          <input class="modal-input y-input" name="hostPath" placeholder="/Users/name/projects" required
            ref=${(el: HTMLInputElement) => { setElMountHostPath(el); }} />
          <label class="modal-check">
            <input type="checkbox" name="readOnly"
              ref=${(el: HTMLInputElement) => { setElMountReadonly(el); }} />
            Read-only mount
          </label>
          <div class="y-modal-actions">
            <button class="toolbar-btn y-btn y-btn-sm" type="button" onClick=${closeMountDialog}>Cancel</button>
            <button class="toolbar-btn y-btn y-btn-sm y-btn-primary" type="submit">Request Mount</button>
          </div>
        </form>
      </div>
    </div>
  <//>
`;
};

// ── App Protocol & View ────────────────────────────────────

export default defineApp({
  id: 'storage',
  name: 'Storage Browser',
  state: {
    'current-path': {
      description: 'Current directory path being viewed',
      get: () => state.currentPath,
    },
    'directory-listing': {
      description: 'Files and folders in the current directory',
      get: () =>
        state.entries.map((e) => ({
          path: e.path,
          name: basename(e.path),
          isDirectory: e.isDirectory,
          size: e.size,
        })),
    },
    'selected-file': {
      description: 'Currently selected file path (null if none)',
      get: () => state.selectedFile,
    },
    'mount-aliases': {
      description: 'Mounted folders available under mounts/',
      get: () => [...state.mountAliases],
    },
    'file-preview': {
      description: 'Text content of the currently previewed file (null if not text)',
      get: () => state.previewContent,
    },
    layout: {
      description:
        'Current layout state. The file preview always fills the whole window as the background; the directory listing lives in a left hover-open overlay panel. navOpen is whether the panel is currently visible, navPinned whether it is pinned open, panelWidth its width in px.',
      get: () => ({
        navOpen: navOpen(),
        navPinned: navPinned(),
        panelWidth: panelWidth(),
        minPanelWidth: MIN_PANEL_WIDTH,
        maxPanelWidth: maxPanelWidth(),
        defaultPanelWidth: DEFAULT_PANEL_WIDTH,
      }),
    },
  },
  commands: {
    navigate: {
      description: 'Navigate to a directory path',
      params: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Directory path to navigate to' } },
        required: ['path'],
      },
      run: (params) => {
        navigate(String(params.path));
        return { success: true, path: params.path };
      },
    },
    'select-file': {
      description: 'Select and preview a file',
      params: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File path to select' } },
        required: ['path'],
      },
      run: (params) => {
        const entry = state.entries.find((e) => e.path === params.path);
        if (!entry || entry.isDirectory) return { success: false, error: 'File not found' };
        selectFile(entry);
        return { success: true };
      },
    },
    'request-mount': {
      description: 'Send a mount request for the agent to execute with host permission',
      params: {
        type: 'object',
        properties: {
          alias: { type: 'string', description: 'Mount alias (example: project-files)' },
          hostPath: { type: 'string', description: 'Absolute host folder path' },
          readOnly: { type: 'boolean', description: 'Whether mount should be read-only' },
        },
        required: ['alias', 'hostPath'],
      },
      run: (params) => {
        if (!app?.sendInteraction) return { success: false, error: 'Agent bridge unavailable' };
        app.sendInteraction({
          event: 'storage_mount_request',
          source: 'storage',
          alias: sanitizeAlias(String(params.alias || '')),
          hostPath: String(params.hostPath || ''),
          readOnly: Boolean(params.readOnly),
        });
        return { success: true };
      },
    },
    'set-layout': {
      description:
        'Control the left file-list overlay panel. open opens or closes the panel; pinned toggles pin (pinned keeps it open even when the cursor leaves). panelWidth sets the panel width in px (auto-clamped to 300..70% of the window); reset:true restores the default width. Width is persisted and restored on relaunch.',
      params: {
        type: 'object',
        properties: {
          open: { type: 'boolean', description: 'true opens the panel, false closes it' },
          pinned: { type: 'boolean', description: 'true pins the panel open' },
          panelWidth: { type: 'number', description: 'Panel width in px' },
          reset: { type: 'boolean', description: 'true resets panel width to the default' },
        },
      },
      run: (params) => {
        // Pin first: setNavPin(true) implies open, so an explicit open:false
        // in the same call can still override it.
        if (typeof params.pinned === 'boolean') setNavPin(params.pinned);
        if (params.open === true) openNav();
        else if (params.open === false) closeNav();

        if (params.reset) {
          resetPanelWidth();
        } else if (typeof params.panelWidth === 'number' && Number.isFinite(params.panelWidth)) {
          setPanelWidth(params.panelWidth);
        }
        return { navOpen: navOpen(), navPinned: navPinned(), panelWidth: panelWidth() };
      },
    },
    refresh: {
      description: 'Refresh the current directory listing',
      params: { type: 'object', properties: {} },
      run: () => {
        navigate(state.currentPath);
        return { success: true };
      },
    },
  },
  view: App,
});
