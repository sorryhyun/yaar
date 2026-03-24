export {};
import { For, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import './styles.css';
import type { StorageEntry } from './types';
import { state, setState, setElMountAlias, setElMountHostPath, setElMountReadonly, setElPreviewBody } from './state';
import { basename, formatSize, getFileIcon } from './helpers';
import { handleDragStart, handleDragEnd, requestOpenByAgent } from './drag';
import { openMountDialog, closeMountDialog, submitMountRequest } from './mount-dialog';
import { navigate, selectFile, closePreview } from './navigation';
import { registerProtocol } from './protocol';
import { storage, showToast } from '@bundled/yaar';

// ── Upload ───────────────────────────────────────────────────────────────────────

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

// ── Template ───────────────────────────────────────────────────────────────────

const App = () => html`
  <div class="toolbar y-flex-between">
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
    <button class="toolbar-btn y-btn y-btn-sm" onClick=${openMountDialog} title="Request mount folder">Mount...</button>
    <button class="toolbar-btn y-btn y-btn-sm" onClick=${() => navigate(state.currentPath)} title="Refresh">↻</button>
    <button class="toolbar-btn y-btn y-btn-sm" onClick=${openUploadDialog} title="Upload files">⬆ Upload</button>
    <input type="file" id="upload-input" multiple style="display:none"
      ref=${(el: HTMLInputElement) => { uploadInput = el; }}
      onChange=${handleUpload} />
  </div>

  <div class="main">
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
                      if (!confirm(`Delete "${name}"?`)) return;
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

    <div class=${() => `preview${state.showPreview ? '' : ' hidden'}`}>
      <div class="y-label preview-header y-flex-between">
        <span class="y-truncate">${() => state.previewTitleText}</span>
        <button class="preview-close" onClick=${closePreview}>✕</button>
      </div>
      <div class="preview-body" ref=${(el: HTMLDivElement) => { setElPreviewBody(el); }}></div>
      <div class="preview-meta y-text-xs y-text-muted">${() => state.previewMetaText}</div>
    </div>
  </div>

  <${Show} when=${() => state.showModal}>
    <div class="modal-overlay" onClick=${(e: MouseEvent) => {
      if (e.target === e.currentTarget) closeMountDialog();
    }}>
      <div class="modal-card y-card">
        <div class="modal-title">Request Host Folder Mount</div>
        <div class="modal-note y-text-sm y-text-muted">The app cannot mount folders directly. Submit a request and the agent will ask for permission and run the mount tool.</div>
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
          <div class="modal-actions">
            <button class="toolbar-btn y-btn y-btn-sm" type="button" onClick=${closeMountDialog}>Cancel</button>
            <button class="toolbar-btn y-btn y-btn-sm y-btn-primary" type="submit">Request Mount</button>
          </div>
        </form>
      </div>
    </div>
  <//>

  <div class="statusbar y-text-xs y-text-muted">${() => state.statusText}</div>
`;

render(App, document.getElementById('app')!);

// ── App Protocol & Init ───────────────────────────────────────────────────

registerProtocol();
navigate('');
