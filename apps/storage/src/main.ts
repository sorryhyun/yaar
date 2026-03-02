export {};
import { html, mount, show } from '@bundled/yaar';
import './styles.css';
import { currentPath, entries, mountAliases, selectedFile, showPreview, showModal, statusText, previewTitleText, previewMetaText, setElMountAlias, setElMountHostPath, setElMountReadonly, setElPreviewBody } from './state';
import { basename, formatSize, getFileIcon } from './helpers';
import { handleDragStart, handleDragEnd, requestOpenByAgent } from './drag';
import { openMountDialog, closeMountDialog, submitMountRequest } from './mount-dialog';
import { navigate, selectFile, closePreview } from './navigation';
import { registerProtocol } from './protocol';

// ── Template ──────────────────────────────────────────────────────────

mount(html`
  <div class="toolbar y-flex-between">
    <div class="breadcrumb">
      ${() => {
        const parts = currentPath() ? currentPath().split('/').filter(Boolean) : [];
        const crumbs: any[] = [
          html`<button onClick=${() => navigate('')}>storage://</button>`
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
      ${() => mountAliases().map(alias => html`<option value="${alias}">${alias}</option>`)}
    </select>
    <button class="toolbar-btn y-btn y-btn-sm" onClick=${openMountDialog} title="Request mount folder">Mount...</button>
    <button class="toolbar-btn y-btn y-btn-sm" onClick=${() => navigate(currentPath())} title="Refresh">&#x21BB;</button>
  </div>

  <div class="main">
    <div class="file-list y-scroll">
      ${() => {
        const list = entries();
        if (list.length === 0) return html`<div class="empty">This folder is empty</div>`;
        return list.map(entry => {
          const name = basename(entry.path);
          return html`
            <div
              class=${() => `file-row${selectedFile() === entry.path ? ' selected' : ''}`}
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
                ${!entry.isDirectory ? html`
                  <button title="Open in new tab" onClick=${(e: MouseEvent) => {
                    e.stopPropagation();
                    window.open((window as any).yaar?.storage?.url(entry.path), '_blank');
                  }}>&#x21D7;</button>
                ` : ''}
                <button class="danger" title="Delete" onClick=${async (e: MouseEvent) => {
                  e.stopPropagation();
                  if (!confirm(`Delete "${name}"?`)) return;
                  try {
                    await (window as any).yaar?.storage?.remove(entry.path);
                    navigate(currentPath());
                  } catch {
                    statusText(`Failed to delete ${name}`);
                  }
                }}>&#x1F5D1;</button>
              </span>
            </div>
          `;
        });
      }}
    </div>

    <div class=${() => `preview${showPreview() ? '' : ' hidden'}`}>
      <div class="preview-header y-flex-between">
        <span class="y-truncate">${() => previewTitleText()}</span>
        <button class="preview-close" onClick=${closePreview}>&#x2715;</button>
      </div>
      <div class="preview-body" ref=${(el: HTMLDivElement) => { setElPreviewBody(el); }}></div>
      <div class="preview-meta y-text-xs y-text-muted">${() => previewMetaText()}</div>
    </div>
  </div>

  ${show(() => showModal(), () => html`
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
  `)}

  <div class="statusbar y-text-xs y-text-muted">${() => statusText()}</div>
`);

// ── App Protocol & Init ────────────────────────────────────────────────

registerProtocol();
navigate('');
