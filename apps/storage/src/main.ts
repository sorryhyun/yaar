/**
 * Storage File Browser — visual file manager with App Protocol support.
 *
 * Uses the injected `window.yaar.storage` SDK for file operations
 * and `window.yaar.app` for AI agent communication.
 */

// ── Types ──────────────────────────────────────────────────────────

interface StorageEntry {
  path: string;
  isDirectory: boolean;
  size?: number;
  modified?: string;
}

interface StorageSDK {
  list(path: string): Promise<StorageEntry[]>;
  read(path: string, opts?: { as?: string }): Promise<string>;
  save(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
  url(path: string): string;
}

interface AppSDK {
  register(config: {
    appId: string;
    name: string;
    state: Record<string, { description: string; handler: () => unknown }>;
    commands: Record<
      string,
      {
        description: string;
        params?: unknown;
        handler: (params: Record<string, unknown>) => unknown;
      }
    >;
  }): void;
  sendInteraction?: (payload: unknown) => void;
}

// ── State ──────────────────────────────────────────────────────────

let currentPath = '';
let entries: StorageEntry[] = [];
let mountAliases: string[] = [];
let selectedFile: string | null = null;
let previewContent: string | null = null;

const yaar = (window as unknown as { yaar?: { storage?: StorageSDK; app?: AppSDK } }).yaar;
const storage = yaar?.storage;
const appApi = yaar?.app;

// ── Helpers ────────────────────────────────────────────────────────

function basename(path: string): string {
  const parts = path.replace(/\/$/, '').split('/');
  return parts[parts.length - 1] || path;
}

function sanitizeAlias(alias: string): string {
  return alias.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function formatSize(bytes?: number): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileIcon(name: string, isDir: boolean): string {
  if (isDir) return '\uD83D\uDCC1';
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const icons: Record<string, string> = {
    pdf: '\uD83D\uDCC4', txt: '\uD83D\uDCDD', md: '\uD83D\uDCDD',
    json: '{}', csv: '\uD83D\uDCCA', html: '\uD83C\uDF10', xml: '\uD83C\uDF10',
    png: '\uD83D\uDDBC\uFE0F', jpg: '\uD83D\uDDBC\uFE0F', jpeg: '\uD83D\uDDBC\uFE0F',
    gif: '\uD83D\uDDBC\uFE0F', svg: '\uD83D\uDDBC\uFE0F', webp: '\uD83D\uDDBC\uFE0F',
    mp3: '\uD83C\uDFB5', wav: '\uD83C\uDFB5', mp4: '\uD83C\uDFA5', webm: '\uD83C\uDFA5',
    zip: '\uD83D\uDCE6', tar: '\uD83D\uDCE6', gz: '\uD83D\uDCE6',
    js: '\uD83D\uDFE8', ts: '\uD83D\uDD35', py: '\uD83D\uDC0D',
  };
  return icons[ext] || '\uD83D\uDCC4';
}

function isPreviewable(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return ['txt', 'md', 'json', 'csv', 'html', 'xml', 'js', 'ts', 'py', 'css', 'yaml', 'yml', 'toml', 'log', 'sh', 'bat', 'env'].includes(ext);
}

function isImage(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext);
}

function getExtension(name: string): string {
  return name.includes('.') ? (name.split('.').pop()?.toLowerCase() || '') : '';
}

function requestOpenByAgent(entry: StorageEntry) {
  if (!appApi?.sendInteraction) return;
  const name = basename(entry.path);
  const extension = getExtension(name);
  appApi.sendInteraction({
    event: 'open_file_request',
    source: 'storage',
    path: entry.path,
    name,
    extension,
    isDirectory: entry.isDirectory,
  });
  elStatusbar.textContent = `Requested agent open: ${name}`;
}

// ── DOM Setup ──────────────────────────────────────────────────────

const root = document.getElementById('app') || document.body;

root.innerHTML = `
<style>
  :root {
    --bg: #1a1a2e;
    --surface: #16213e;
    --surface-hover: #1a2744;
    --border: #2a3a5c;
    --text: #e0e0e0;
    --text-dim: #8899aa;
    --accent: #4fc3f7;
    --accent-dim: #29688a;
    --danger: #ef5350;
  }
  #app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: var(--bg);
    color: var(--text);
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 13px;
    overflow: hidden;
  }

  /* Toolbar */
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .breadcrumb {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: 1;
    min-width: 0;
    overflow-x: auto;
  }
  .breadcrumb button {
    background: none;
    border: none;
    color: var(--accent);
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 13px;
    white-space: nowrap;
  }
  .breadcrumb button:hover { background: var(--surface-hover); }
  .breadcrumb button:last-child { color: var(--text); cursor: default; }
  .breadcrumb .sep { color: var(--text-dim); font-size: 11px; }
  .toolbar-btn {
    background: var(--surface-hover);
    border: 1px solid var(--border);
    color: var(--text);
    cursor: pointer;
    padding: 4px 10px;
    border-radius: 4px;
    font-size: 12px;
    white-space: nowrap;
  }
  .toolbar-btn:hover { border-color: var(--accent-dim); }
  .toolbar-select {
    background: var(--surface-hover);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: 4px;
    font-size: 12px;
    height: 26px;
    max-width: 180px;
  }

  .modal {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: none;
    align-items: center;
    justify-content: center;
    z-index: 20;
  }
  .modal.open { display: flex; }
  .modal-card {
    width: min(520px, calc(100vw - 32px));
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px;
    box-shadow: 0 14px 40px rgba(0, 0, 0, 0.5);
  }
  .modal-title { font-size: 14px; font-weight: 600; margin-bottom: 8px; }
  .modal-note { color: var(--text-dim); font-size: 12px; line-height: 1.4; margin-bottom: 12px; }
  .modal-form { display: grid; gap: 10px; }
  .modal-label { font-size: 12px; color: var(--text-dim); }
  .modal-input {
    width: 100%;
    box-sizing: border-box;
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: 4px;
    padding: 7px 9px;
    font-size: 12px;
  }
  .modal-check { display: flex; align-items: center; gap: 6px; font-size: 12px; }
  .modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }

  /* Main content */
  .main {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  /* File list */
  .file-list {
    flex: 1;
    overflow-y: auto;
    padding: 4px 0;
    min-width: 0;
  }
  .file-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    cursor: pointer;
    border-bottom: 1px solid transparent;
  }
  .file-row:hover { background: var(--surface-hover); }
  .file-row.selected { background: var(--accent-dim); }
  .file-icon { width: 24px; text-align: center; font-size: 16px; flex-shrink: 0; }
  .file-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .file-name.dir { color: var(--accent); }
  .file-size { color: var(--text-dim); font-size: 12px; flex-shrink: 0; width: 70px; text-align: right; }
  .file-actions { display: flex; gap: 4px; opacity: 0; transition: opacity 0.15s; }
  .file-row:hover .file-actions { opacity: 1; }
  .file-actions button {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 14px;
    padding: 2px 4px;
    border-radius: 3px;
    color: var(--text-dim);
  }
  .file-actions button:hover { background: var(--border); color: var(--text); }
  .file-actions button.danger:hover { color: var(--danger); }

  /* Empty state */
  .empty {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    color: var(--text-dim);
    font-size: 14px;
    padding: 40px;
  }

  /* Preview panel */
  .preview {
    width: 320px;
    border-left: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    background: var(--surface);
    flex-shrink: 0;
  }
  .preview-header {
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    font-weight: 600;
    font-size: 12px;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .preview-close {
    background: none;
    border: none;
    color: var(--text-dim);
    cursor: pointer;
    font-size: 16px;
    padding: 0 4px;
  }
  .preview-close:hover { color: var(--text); }
  .preview-body {
    flex: 1;
    overflow: auto;
    padding: 12px;
  }
  .preview-body pre {
    white-space: pre-wrap;
    word-break: break-all;
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 12px;
    line-height: 1.5;
    color: var(--text);
    margin: 0;
  }
  .preview-body img {
    max-width: 100%;
    border-radius: 4px;
  }
  .preview-meta {
    padding: 8px 12px;
    border-top: 1px solid var(--border);
    font-size: 11px;
    color: var(--text-dim);
  }

  /* Status bar */
  .statusbar {
    padding: 4px 12px;
    background: var(--surface);
    border-top: 1px solid var(--border);
    font-size: 11px;
    color: var(--text-dim);
    flex-shrink: 0;
  }

  /* Scrollbar */
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--accent-dim); }
</style>

<div class="toolbar">
  <div class="breadcrumb" id="breadcrumb"></div>
  <select class="toolbar-select" id="mount-select" title="Jump to mounted folder">
    <option value="">Mounts</option>
  </select>
  <button class="toolbar-btn" id="btn-mount" title="Request mount folder">Mount...</button>
  <button class="toolbar-btn" id="btn-refresh" title="Refresh">\u21BB</button>
</div>
<div class="main">
  <div class="file-list" id="file-list"></div>
  <div class="preview" id="preview" style="display:none">
    <div class="preview-header">
      <span id="preview-title">Preview</span>
      <button class="preview-close" id="preview-close">\u2715</button>
    </div>
    <div class="preview-body" id="preview-body"></div>
    <div class="preview-meta" id="preview-meta"></div>
  </div>
</div>
<div class="modal" id="mount-modal">
  <div class="modal-card">
    <div class="modal-title">Request Host Folder Mount</div>
    <div class="modal-note">The app cannot mount folders directly. Submit a request and the agent will ask for permission and run the mount tool.</div>
    <form class="modal-form" id="mount-form">
      <label class="modal-label" for="mount-alias">Mount alias</label>
      <input class="modal-input" id="mount-alias" name="alias" placeholder="project-files" required />
      <label class="modal-label" for="mount-host-path">Host folder path</label>
      <input class="modal-input" id="mount-host-path" name="hostPath" placeholder="/Users/name/projects" required />
      <label class="modal-check" for="mount-readonly">
        <input type="checkbox" id="mount-readonly" name="readOnly" />
        Read-only mount
      </label>
      <div class="modal-actions">
        <button class="toolbar-btn" type="button" id="mount-cancel">Cancel</button>
        <button class="toolbar-btn" type="submit" id="mount-submit">Request Mount</button>
      </div>
    </form>
  </div>
</div>
<div class="statusbar" id="statusbar">Ready</div>
`;

const elBreadcrumb = document.getElementById('breadcrumb')!;
const elMountSelect = document.getElementById('mount-select') as HTMLSelectElement;
const elMountModal = document.getElementById('mount-modal')!;
const elMountForm = document.getElementById('mount-form') as HTMLFormElement;
const elMountAlias = document.getElementById('mount-alias') as HTMLInputElement;
const elMountHostPath = document.getElementById('mount-host-path') as HTMLInputElement;
const elMountReadonly = document.getElementById('mount-readonly') as HTMLInputElement;
const elFileList = document.getElementById('file-list')!;
const elPreview = document.getElementById('preview')!;
const elPreviewTitle = document.getElementById('preview-title')!;
const elPreviewBody = document.getElementById('preview-body')!;
const elPreviewMeta = document.getElementById('preview-meta')!;
const elStatusbar = document.getElementById('statusbar')!;

document.getElementById('btn-refresh')!.onclick = () => navigate(currentPath);
document.getElementById('btn-mount')!.onclick = openMountDialog;
document.getElementById('mount-cancel')!.onclick = closeMountDialog;
document.getElementById('preview-close')!.onclick = closePreview;
elMountForm.addEventListener('submit', submitMountRequest);
elMountModal.addEventListener('click', (e) => {
  if (e.target === elMountModal) closeMountDialog();
});
elMountSelect.addEventListener('change', () => {
  if (!elMountSelect.value) return;
  navigate(`mounts/${elMountSelect.value}`);
  elMountSelect.value = '';
});

// ── Mount UI ───────────────────────────────────────────────────────

function openMountDialog() {
  elMountForm.reset();
  elMountModal.classList.add('open');
  elMountAlias.focus();
}

function closeMountDialog() {
  elMountModal.classList.remove('open');
}

async function submitMountRequest(e: Event) {
  e.preventDefault();
  const alias = sanitizeAlias(elMountAlias.value);
  const hostPath = elMountHostPath.value.trim();

  if (!alias) {
    elStatusbar.textContent = 'Mount alias is required';
    return;
  }
  if (!hostPath) {
    elStatusbar.textContent = 'Host folder path is required';
    return;
  }

  if (!appApi?.sendInteraction) {
    elStatusbar.textContent = 'Agent bridge unavailable: cannot send mount request';
    return;
  }

  appApi.sendInteraction({
    event: 'storage_mount_request',
    source: 'storage',
    alias,
    hostPath,
    readOnly: elMountReadonly.checked,
  });

  closeMountDialog();
  elStatusbar.textContent = `Mount request sent for ${alias}`;
}

async function refreshMountAliases() {
  try {
    const items = await storage.list('mounts');
    mountAliases = items.filter((entry) => entry.isDirectory).map((entry) => basename(entry.path)).sort((a, b) => a.localeCompare(b));
  } catch {
    mountAliases = [];
  }

  const options = ['<option value="">Mounts</option>'];
  for (const alias of mountAliases) {
    options.push(`<option value="${alias}">${alias}</option>`);
  }
  elMountSelect.innerHTML = options.join('');
}

// ── Navigation ─────────────────────────────────────────────────────

async function navigate(path: string) {
  currentPath = path;
  selectedFile = null;
  previewContent = null;
  closePreview();
  renderBreadcrumb();
  elFileList.innerHTML = '';
  elStatusbar.textContent = 'Loading...';

  try {
    await refreshMountAliases();
    entries = await storage.list(path);
    // Sort: directories first, then alphabetically
    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return basename(a.path).localeCompare(basename(b.path));
    });
    renderFileList();
    const dirs = entries.filter((e) => e.isDirectory).length;
    const files = entries.length - dirs;
    elStatusbar.textContent = `${files} file${files !== 1 ? 's' : ''}, ${dirs} folder${dirs !== 1 ? 's' : ''}`;
  } catch (err) {
    elFileList.innerHTML = `<div class="empty">Failed to load directory</div>`;
    elStatusbar.textContent = 'Error loading directory';
  }
}

function renderBreadcrumb() {
  const parts = currentPath ? currentPath.split('/').filter(Boolean) : [];
  let html = `<button data-path="">storage://</button>`;
  let accumulated = '';
  for (let i = 0; i < parts.length; i++) {
    accumulated += (accumulated ? '/' : '') + parts[i];
    html += `<span class="sep">/</span>`;
    html += `<button data-path="${accumulated}">${parts[i]}</button>`;
  }
  elBreadcrumb.innerHTML = html;
  elBreadcrumb.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = btn.getAttribute('data-path') || '';
      navigate(p);
    });
  });
}

function renderFileList() {
  if (entries.length === 0) {
    elFileList.innerHTML = `<div class="empty">This folder is empty</div>`;
    return;
  }

  elFileList.innerHTML = '';
  for (const entry of entries) {
    const name = basename(entry.path);
    const row = document.createElement('div');
    row.className = 'file-row';
    row.dataset.path = entry.path;

    row.innerHTML = `
      <span class="file-icon">${getFileIcon(name, entry.isDirectory)}</span>
      <span class="file-name${entry.isDirectory ? ' dir' : ''}">${name}</span>
      <span class="file-size">${entry.isDirectory ? '' : formatSize(entry.size)}</span>
      <span class="file-actions">
        ${!entry.isDirectory ? `<button class="act-open" title="Open in new tab">\u21D7</button>` : ''}
        <button class="act-delete danger" title="Delete">\uD83D\uDDD1</button>
      </span>
    `;

    // Click: navigate or preview
    row.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.file-actions')) return;
      if (entry.isDirectory) {
        navigate(entry.path);
      } else {
        selectFile(entry);
      }
    });

    // Double click: ask agent to open file with appropriate app
    row.addEventListener('dblclick', (e) => {
      if ((e.target as HTMLElement).closest('.file-actions')) return;
      if (!entry.isDirectory) requestOpenByAgent(entry);
    });

    // Open in new tab
    row.querySelector('.act-open')?.addEventListener('click', () => {
      window.open(storage.url(entry.path), '_blank');
    });

    // Delete
    row.querySelector('.act-delete')?.addEventListener('click', async () => {
      if (!confirm(`Delete "${name}"?`)) return;
      try {
        await storage.remove(entry.path);
        navigate(currentPath);
      } catch {
        elStatusbar.textContent = `Failed to delete ${name}`;
      }
    });

    elFileList.appendChild(row);
  }
}

// ── Preview ────────────────────────────────────────────────────────

async function selectFile(entry: StorageEntry) {
  const name = basename(entry.path);
  selectedFile = entry.path;
  previewContent = null;

  // Highlight selected row
  elFileList.querySelectorAll('.file-row').forEach((r) => {
    const row = r as HTMLElement;
    row.classList.toggle('selected', row.dataset.path === entry.path);
  });

  elPreview.style.display = 'flex';
  elPreviewTitle.textContent = name;
  elPreviewBody.innerHTML = '<span style="color:var(--text-dim)">Loading...</span>';
  elPreviewMeta.textContent = formatSize(entry.size);

  if (isImage(name)) {
    elPreviewBody.innerHTML = `<img src="${storage.url(entry.path)}" alt="${name}" />`;
    return;
  }

  if (isPreviewable(name)) {
    try {
      const content = await storage.read(entry.path, { as: 'text' });
      previewContent = content;
      const escaped = content
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      elPreviewBody.innerHTML = `<pre>${escaped}</pre>`;
    } catch {
      elPreviewBody.innerHTML = '<span style="color:var(--text-dim)">Unable to preview</span>';
    }
    return;
  }

  elPreviewBody.innerHTML = `
    <div style="text-align:center;padding:20px">
      <div style="font-size:32px;margin-bottom:8px">${getFileIcon(name, false)}</div>
      <div style="color:var(--text-dim);margin-bottom:12px">No preview available</div>
      <button class="toolbar-btn" id="open-external">Open in browser</button>
    </div>
  `;
  document.getElementById('open-external')?.addEventListener('click', () => {
    window.open(storage.url(entry.path), '_blank');
  });
}

function closePreview() {
  selectedFile = null;
  previewContent = null;
  elPreview.style.display = 'none';
  elFileList.querySelectorAll('.file-row.selected').forEach((r) => (r as HTMLElement).classList.remove('selected'));
}

// ── App Protocol ───────────────────────────────────────────────────

if (appApi) {
  appApi.register({
    appId: 'storage',
    name: 'Storage Browser',
    state: {
      'current-path': {
        description: 'Current directory path being viewed',
        handler: () => currentPath,
      },
      'directory-listing': {
        description: 'Files and folders in the current directory',
        handler: () =>
          entries.map((e) => ({
            path: e.path,
            name: basename(e.path),
            isDirectory: e.isDirectory,
            size: e.size,
          })),
      },
      'selected-file': {
        description: 'Currently selected file path (null if none)',
        handler: () => selectedFile,
      },
      'mount-aliases': {
        description: 'Mounted folders available under mounts/',
        handler: () => [...mountAliases],
      },
      'file-preview': {
        description: 'Text content of the currently previewed file (null if not text)',
        handler: () => previewContent,
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
        handler: (params) => {
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
        handler: (params) => {
          const entry = entries.find((e) => e.path === params.path);
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
        handler: (params) => {
          if (!appApi?.sendInteraction) return { success: false, error: 'Agent bridge unavailable' };
          appApi.sendInteraction({
            event: 'storage_mount_request',
            source: 'storage',
            alias: sanitizeAlias(String(params.alias || '')),
            hostPath: String(params.hostPath || ''),
            readOnly: Boolean(params.readOnly),
          });
          return { success: true };
        },
      },
      refresh: {
        description: 'Refresh the current directory listing',
        params: { type: 'object', properties: {} },
        handler: () => {
          navigate(currentPath);
          return { success: true };
        },
      },
    },
  });
}

// ── Init ───────────────────────────────────────────────────────────

navigate('');
