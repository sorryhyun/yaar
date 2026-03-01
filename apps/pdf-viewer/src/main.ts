type Mode = 'viewer' | 'export';

type StorageEntry = {
  path: string;
  isDirectory: boolean;
  size?: number;
  modifiedAt?: string;
};

type YaarStorage = {
  read: (path: string, opts?: { as?: 'text' | 'blob' | 'arraybuffer' | 'json' | 'auto' }) => Promise<ArrayBuffer>;
  save: (path: string, data: string) => Promise<void>;
  list: (dirPath?: string) => Promise<StorageEntry[]>;
};

const root = document.getElementById('app');
if (!root) throw new Error('Missing app root');

root.innerHTML = `
  <style>
    :root {
      --yaar-bg: #f8f9fa;
      --yaar-bg-surface: #ffffff;
      --yaar-bg-surface-hover: #f0f1f3;
      --yaar-text: #1f2328;
      --yaar-text-muted: #656d76;
      --yaar-text-dim: #8b949e;
      --yaar-border: #d0d7de;
      --yaar-shadow-sm: 0 1px 2px rgba(0,0,0,.08);
      --yaar-shadow: 0 2px 8px rgba(0,0,0,.1);
    }
    body { margin: 0; background: var(--yaar-bg); color: var(--yaar-text); }
    .wrap { display: grid; grid-template-rows: auto 1fr; height: 100vh; }
    .top {
      display: flex;
      gap: 8px;
      align-items: center;
      padding: 10px;
      border-bottom: 1px solid var(--yaar-border);
      background: var(--yaar-bg-surface);
      flex-wrap: wrap;
    }
    .top button.active { background: var(--yaar-accent); color: #fff; border-color: var(--yaar-accent); }
    .top .spacer { flex: 1; }
    .pane { height: calc(100vh - 58px); }
    .hidden { display: none !important; }
    .viewer-pane { display: grid; grid-template-rows: auto 1fr; }
    .viewer-controls {
      display: flex;
      gap: 8px;
      padding: 10px;
      border-bottom: 1px solid var(--yaar-border);
      align-items: center;
      flex-wrap: wrap;
    }
    .storage-browser {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    .storage-list {
      min-width: 300px;
      max-width: 420px;
    }
    .viewer-frame {
      width: 100%;
      height: 100%;
      border: 0;
      background: var(--yaar-bg-surface-hover);
    }
    .drop {
      border: 2px dashed var(--yaar-border);
      border-radius: 12px;
      padding: 28px;
      margin: 12px;
      text-align: center;
      color: var(--yaar-text-muted);
    }
    .drop.drag { border-color: var(--yaar-accent); color: var(--yaar-accent); }
    .export-pane { display: grid; grid-template-columns: 1fr 1fr; height: 100%; }
    .left, .right { padding: 10px; overflow: auto; }
    .left { border-right: 1px solid var(--yaar-border); }
    textarea {
      width: 100%;
      height: calc(100% - 60px);
      min-height: 220px;
      resize: vertical;
      border: 1px solid var(--yaar-border);
      border-radius: var(--yaar-radius);
      padding: 10px;
      box-sizing: border-box;
      background: var(--yaar-bg-surface);
      color: var(--yaar-text);
      font: inherit;
    }
    .preview {
      background: var(--yaar-bg-surface);
      border: 1px solid var(--yaar-border);
      border-radius: var(--yaar-radius);
      padding: 20px;
      min-height: 92%;
      color: var(--yaar-text);
    }
    @media print {
      body * { visibility: hidden !important; }
      #print-area, #print-area * { visibility: visible !important; }
      #print-area {
        position: fixed;
        inset: 0;
        background: white;
        color: #000;
        padding: 20mm;
      }
    }
  </style>

  <div class="wrap">
    <div class="top y-flex y-flex-between">
      <button id="btn-viewer" class="y-btn y-btn-sm active">PDF Viewer</button>
      <button id="btn-export" class="y-btn y-btn-sm">Export to PDF</button>
      <div class="spacer"></div>
      <span id="global-status" class="y-text-sm y-text-muted">Ready</span>
    </div>

    <div id="viewer-pane" class="pane viewer-pane">
      <div class="viewer-controls y-flex-between">
        <input id="file-input" type="file" accept="application/pdf" />
        <button id="clear-pdf" class="y-btn y-btn-sm">Clear</button>
        <div class="storage-browser">
          <button id="storage-up" class="y-btn y-btn-sm">Up</button>
          <button id="storage-refresh" class="y-btn y-btn-sm">Refresh</button>
          <span id="storage-current" class="y-text-sm y-text-muted">Storage: /</span>
          <select id="storage-list" class="storage-list y-input">
            <option>Loading...</option>
          </select>
        </div>
        <span id="pdf-status" class="y-text-sm y-text-muted">No PDF loaded.</span>
      </div>
      <div id="drop" class="drop">Drop a PDF file here, or use the file picker above.</div>
      <iframe id="pdf-frame" class="viewer-frame hidden"></iframe>
    </div>

    <div id="export-pane" class="pane export-pane hidden">
      <div class="left">
        <h3 style="margin: 0 0 8px;">Content</h3>
        <p class="y-text-xs y-text-muted" style="margin-top: 0;">Type plain text or basic HTML. Use preview, then click "Export PDF".</p>
        <textarea id="content-input" placeholder="Paste document/content here..."></textarea>
      </div>
      <div class="right">
        <div style="display: flex; gap: 8px; margin-bottom: 10px;">
          <button id="preview-btn" class="y-btn y-btn-sm">Refresh Preview</button>
          <button id="export-btn" class="y-btn y-btn-sm y-btn-primary">Export PDF</button>
          <button id="save-html-btn" class="y-btn y-btn-sm">Save HTML to Storage</button>
        </div>
        <div id="print-area" class="preview"></div>
      </div>
    </div>
  </div>
`;

const els = {
  btnViewer: document.getElementById('btn-viewer') as HTMLButtonElement,
  btnExport: document.getElementById('btn-export') as HTMLButtonElement,
  viewerPane: document.getElementById('viewer-pane') as HTMLDivElement,
  exportPane: document.getElementById('export-pane') as HTMLDivElement,
  globalStatus: document.getElementById('global-status') as HTMLSpanElement,
  fileInput: document.getElementById('file-input') as HTMLInputElement,
  pdfFrame: document.getElementById('pdf-frame') as HTMLIFrameElement,
  pdfStatus: document.getElementById('pdf-status') as HTMLSpanElement,
  drop: document.getElementById('drop') as HTMLDivElement,
  clearPdf: document.getElementById('clear-pdf') as HTMLButtonElement,
  storageUp: document.getElementById('storage-up') as HTMLButtonElement,
  storageRefresh: document.getElementById('storage-refresh') as HTMLButtonElement,
  storageCurrent: document.getElementById('storage-current') as HTMLSpanElement,
  storageList: document.getElementById('storage-list') as HTMLSelectElement,
  contentInput: document.getElementById('content-input') as HTMLTextAreaElement,
  previewBtn: document.getElementById('preview-btn') as HTMLButtonElement,
  exportBtn: document.getElementById('export-btn') as HTMLButtonElement,
  saveHtmlBtn: document.getElementById('save-html-btn') as HTMLButtonElement,
  printArea: document.getElementById('print-area') as HTMLDivElement,
};

let mode: Mode = 'viewer';
let currentPdfUrl: string | null = null;
let currentStorageDir = '';

function getStorage(): YaarStorage | null {
  const maybeWindow = window as unknown as { yaar?: { storage?: YaarStorage } };
  return maybeWindow.yaar?.storage ?? null;
}

function setMode(next: Mode) {
  mode = next;
  const viewer = next === 'viewer';
  els.viewerPane.classList.toggle('hidden', !viewer);
  els.exportPane.classList.toggle('hidden', viewer);
  els.btnViewer.classList.toggle('active', viewer);
  els.btnExport.classList.toggle('active', !viewer);
  els.globalStatus.textContent = viewer ? 'Viewer mode' : 'Export mode';
}

function cleanStoragePath(path: string): string {
  return path.trim().replace(/^\/+/, '').replace(/\/+/g, '/').replace(/\/$/, '');
}

function parentDir(path: string): string {
  const clean = cleanStoragePath(path);
  if (!clean) return '';
  const parts = clean.split('/');
  parts.pop();
  return parts.join('/');
}

function basename(path: string): string {
  const clean = cleanStoragePath(path);
  const idx = clean.lastIndexOf('/');
  return idx === -1 ? clean : clean.slice(idx + 1);
}

function revokeCurrentPdfUrl() {
  if (currentPdfUrl && currentPdfUrl.startsWith('blob:')) URL.revokeObjectURL(currentPdfUrl);
  currentPdfUrl = null;
}

function showPdfUrl(url: string, label: string) {
  revokeCurrentPdfUrl();
  currentPdfUrl = url;
  els.pdfFrame.src = url;
  els.pdfFrame.classList.remove('hidden');
  els.drop.classList.add('hidden');
  els.pdfStatus.textContent = `Loaded: ${label}`;
  els.globalStatus.textContent = 'PDF loaded';
}

async function openFromStorage(path: string) {
  const clean = cleanStoragePath(path);
  if (!clean) {
    els.pdfStatus.textContent = 'Select a PDF file from storage first.';
    return;
  }
  const storage = getStorage();
  if (!storage) {
    els.pdfStatus.textContent = 'Storage API unavailable in this app context.';
    return;
  }
  try {
    const bytes = await storage.read(clean, { as: 'arraybuffer' });
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    showPdfUrl(url, clean);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    els.pdfStatus.textContent = `Failed to read storage file: ${msg}`;
  }
}

function setStorageListPlaceholder(message: string) {
  els.storageList.innerHTML = '';
  const option = document.createElement('option');
  option.textContent = message;
  option.disabled = true;
  option.selected = true;
  els.storageList.appendChild(option);
}

async function loadStorageList(dir = currentStorageDir) {
  const storage = getStorage();
  if (!storage) {
    els.storageCurrent.textContent = 'Storage unavailable';
    setStorageListPlaceholder('Storage API unavailable');
    return;
  }

  const cleanDir = cleanStoragePath(dir);
  currentStorageDir = cleanDir;
  const displayDir = cleanDir ? `/${cleanDir}` : '/';
  els.storageCurrent.textContent = `Storage: ${displayDir}`;

  setStorageListPlaceholder('Loading...');
  try {
    const entries = await storage.list(cleanDir || undefined);
    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.path.localeCompare(b.path);
    });

    els.storageList.innerHTML = '';

    if (cleanDir) {
      const upOpt = document.createElement('option');
      upOpt.value = '__up__';
      upOpt.textContent = '..';
      upOpt.dataset.kind = 'up';
      els.storageList.appendChild(upOpt);
    }

    if (entries.length === 0) {
      setStorageListPlaceholder('This folder is empty');
      return;
    }

    for (const entry of entries) {
      const opt = document.createElement('option');
      const itemPath = cleanStoragePath(entry.path);
      const name = basename(itemPath) || itemPath;
      opt.value = itemPath;
      opt.dataset.kind = entry.isDirectory ? 'dir' : 'file';
      opt.textContent = entry.isDirectory ? `[DIR] ${name}` : name;
      els.storageList.appendChild(opt);
    }

    if (els.storageList.options.length > 0) {
      els.storageList.selectedIndex = 0;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setStorageListPlaceholder(`Load failed: ${msg}`);
  }
}

async function handleStorageSelection() {
  const selected = els.storageList.selectedOptions[0];
  if (!selected) return;

  const kind = selected.dataset.kind;
  if (kind === 'up' || selected.value === '__up__') {
    currentStorageDir = parentDir(currentStorageDir);
    await loadStorageList(currentStorageDir);
    return;
  }

  const path = cleanStoragePath(selected.value);
  if (!path) return;

  if (kind === 'dir') {
    currentStorageDir = path;
    await loadStorageList(currentStorageDir);
    return;
  }

  if (!path.toLowerCase().endsWith('.pdf')) {
    els.pdfStatus.textContent = 'Selected file is not a PDF.';
    return;
  }

  await openFromStorage(path);
}

function renderPreview() {
  const raw = els.contentInput.value.trim();
  if (!raw) {
    els.printArea.innerHTML = '<p style="color:#57606a;">No content yet.</p>';
    return;
  }
  const looksLikeHtml = /<\/?[a-z][\s\S]*>/i.test(raw);
  if (looksLikeHtml) {
    els.printArea.innerHTML = raw;
  } else {
    const escaped = raw
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;')
      .replaceAll('\n', '<br>');
    els.printArea.innerHTML = `<div>${escaped}</div>`;
  }
}

async function saveHtmlSnapshot() {
  const storage = getStorage();
  if (!storage) {
    els.globalStatus.textContent = 'Storage API unavailable';
    return;
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const path = `pdf-viewer/exports/export-${ts}.html`;
  await storage.save(path, els.printArea.innerHTML || '<p></p>');
  els.globalStatus.textContent = `Saved HTML: ${path}`;
}

els.btnViewer.addEventListener('click', () => setMode('viewer'));
els.btnExport.addEventListener('click', () => setMode('export'));

els.fileInput.addEventListener('change', () => {
  const file = els.fileInput.files?.[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  showPdfUrl(url, file.name);
});

els.clearPdf.addEventListener('click', () => {
  revokeCurrentPdfUrl();
  els.pdfFrame.src = '';
  els.pdfFrame.classList.add('hidden');
  els.drop.classList.remove('hidden');
  els.pdfStatus.textContent = 'No PDF loaded.';
  els.globalStatus.textContent = 'Viewer cleared';
});

els.storageUp.addEventListener('click', async () => {
  currentStorageDir = parentDir(currentStorageDir);
  await loadStorageList(currentStorageDir);
});

els.storageRefresh.addEventListener('click', async () => {
  await loadStorageList(currentStorageDir);
});

els.storageList.addEventListener('change', () => {
  void handleStorageSelection();
});

els.drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  els.drop.classList.add('drag');
});
els.drop.addEventListener('dragleave', () => els.drop.classList.remove('drag'));
els.drop.addEventListener('drop', (e) => {
  e.preventDefault();
  els.drop.classList.remove('drag');
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    els.pdfStatus.textContent = 'Only PDF files are supported.';
    return;
  }
  const url = URL.createObjectURL(file);
  showPdfUrl(url, file.name);
});

els.previewBtn.addEventListener('click', () => {
  renderPreview();
  els.globalStatus.textContent = 'Preview updated';
});

els.exportBtn.addEventListener('click', () => {
  renderPreview();
  els.globalStatus.textContent = 'Opening print dialog... choose Save as PDF';
  window.print();
});

els.saveHtmlBtn.addEventListener('click', async () => {
  renderPreview();
  try {
    await saveHtmlSnapshot();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    els.globalStatus.textContent = `Save failed: ${msg}`;
  }
});

els.contentInput.value = `<h1>Document Title</h1>\n<p>Write or paste your content here, then click <strong>Export PDF</strong>.</p>\n<ul><li>Supports plain text</li><li>Supports basic HTML</li></ul>`;
renderPreview();
setMode('viewer');
void loadStorageList('');

window.addEventListener('beforeunload', () => revokeCurrentPdfUrl());
