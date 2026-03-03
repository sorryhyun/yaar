import { createSignal, onMount } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import './styles.css';

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

// --- Signals ---
const [mode, setMode] = createSignal<Mode>('viewer');
const [pdfStatus, setPdfStatus] = createSignal('No PDF loaded.');
const [globalStatus, setGlobalStatus] = createSignal('Ready');
const [storageDir, setStorageDir] = createSignal('');
const [isDragging, setIsDragging] = createSignal(false);
const [hasPdf, setHasPdf] = createSignal(false);
const [storageDirDisplay, setStorageDirDisplay] = createSignal('Storage: /');

// --- Refs ---
let fileInputEl: HTMLInputElement;
let pdfFrameEl: HTMLIFrameElement;
let storageListEl: HTMLSelectElement;
let contentInputEl: HTMLTextAreaElement;
let printAreaEl: HTMLDivElement;

// --- Blob URL management (not reactive — lifecycle managed manually) ---
let currentPdfUrl: string | null = null;

// --- Helpers ---
function getStorage(): YaarStorage | null {
  const maybeWindow = window as unknown as { yaar?: { storage?: YaarStorage } };
  return maybeWindow.yaar?.storage ?? null;
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
  setHasPdf(true);
  pdfFrameEl.src = url;
  setPdfStatus(`Loaded: ${label}`);
  setGlobalStatus('PDF loaded');
}

function clearPdf() {
  revokeCurrentPdfUrl();
  setHasPdf(false);
  pdfFrameEl.src = '';
  setPdfStatus('No PDF loaded.');
  setGlobalStatus('Viewer cleared');
}

async function openFromStorage(path: string) {
  const clean = cleanStoragePath(path);
  if (!clean) {
    setPdfStatus('Select a PDF file from storage first.');
    return;
  }
  const storage = getStorage();
  if (!storage) {
    setPdfStatus('Storage API unavailable in this app context.');
    return;
  }
  try {
    const bytes = await storage.read(clean, { as: 'arraybuffer' });
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    showPdfUrl(url, clean);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setPdfStatus(`Failed to read storage file: ${msg}`);
  }
}

function setStorageListPlaceholder(message: string) {
  if (!storageListEl) return;
  storageListEl.innerHTML = '';
  const option = document.createElement('option');
  option.textContent = message;
  option.disabled = true;
  option.selected = true;
  storageListEl.appendChild(option);
}

async function loadStorageList(dir = storageDir()) {
  const storage = getStorage();
  if (!storage) {
    setStorageDirDisplay('Storage unavailable');
    setStorageListPlaceholder('Storage API unavailable');
    return;
  }

  const cleanDir = cleanStoragePath(dir);
  setStorageDir(cleanDir);
  setStorageDirDisplay(`Storage: ${cleanDir ? `/${cleanDir}` : '/'}`);

  setStorageListPlaceholder('Loading...');
  try {
    const entries = await storage.list(cleanDir || undefined);
    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.path.localeCompare(b.path);
    });

    if (!storageListEl) return;
    storageListEl.innerHTML = '';

    if (cleanDir) {
      const upOpt = document.createElement('option');
      upOpt.value = '__up__';
      upOpt.textContent = '..';
      upOpt.dataset.kind = 'up';
      storageListEl.appendChild(upOpt);
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
      storageListEl.appendChild(opt);
    }

    if (storageListEl.options.length > 0) {
      storageListEl.selectedIndex = 0;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setStorageListPlaceholder(`Load failed: ${msg}`);
  }
}

async function handleStorageSelection() {
  if (!storageListEl) return;
  const selected = storageListEl.selectedOptions[0];
  if (!selected) return;

  const kind = selected.dataset.kind;
  if (kind === 'up' || selected.value === '__up__') {
    const up = parentDir(storageDir());
    setStorageDir(up);
    await loadStorageList(up);
    return;
  }

  const path = cleanStoragePath(selected.value);
  if (!path) return;

  if (kind === 'dir') {
    setStorageDir(path);
    await loadStorageList(path);
    return;
  }

  if (!path.toLowerCase().endsWith('.pdf')) {
    setPdfStatus('Selected file is not a PDF.');
    return;
  }

  await openFromStorage(path);
}

function renderPreview() {
  if (!contentInputEl || !printAreaEl) return;
  const raw = contentInputEl.value.trim();
  if (!raw) {
    printAreaEl.innerHTML = '<p style="color:#57606a;">No content yet.</p>';
    return;
  }
  const looksLikeHtml = /<\/?[a-z][\s\S]*>/i.test(raw);
  if (looksLikeHtml) {
    printAreaEl.innerHTML = raw;
  } else {
    const escaped = raw
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;')
      .replaceAll('\n', '<br>');
    printAreaEl.innerHTML = `<div>${escaped}</div>`;
  }
}

async function saveHtmlSnapshot() {
  const storage = getStorage();
  if (!storage) {
    setGlobalStatus('Storage API unavailable');
    return;
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const path = `pdf-viewer/exports/export-${ts}.html`;
  await storage.save(path, printAreaEl.innerHTML || '<p></p>');
  setGlobalStatus(`Saved HTML: ${path}`);
}

// --- Mount ---
render(() => html`
  <div class="wrap">
    <div class="top">
      <button
        class=${() => 'y-btn y-btn-sm' + (mode() === 'viewer' ? ' active' : '')}
        onClick=${() => { setMode('viewer'); setGlobalStatus('Viewer mode'); }}
      >PDF Viewer</button>
      <button
        class=${() => 'y-btn y-btn-sm' + (mode() === 'export' ? ' active' : '')}
        onClick=${() => { setMode('export'); setGlobalStatus('Export mode'); }}
      >Export to PDF</button>
      <div class="spacer"></div>
      <span class="y-text-sm y-text-muted">${() => globalStatus()}</span>
    </div>

    ${() => mode() === 'viewer' ? html`
      <div class="pane viewer-pane">
        <div class="viewer-controls">
          <input
            type="file"
            accept="application/pdf"
            ref=${(el: HTMLInputElement) => { fileInputEl = el; }}
            onChange=${() => {
              const file = fileInputEl?.files?.[0];
              if (!file) return;
              showPdfUrl(URL.createObjectURL(file), file.name);
            }}
          />
          <button class="y-btn y-btn-sm" onClick=${clearPdf}>Clear</button>
          <div class="storage-browser">
            <button class="y-btn y-btn-sm" onClick=${async () => {
              const up = parentDir(storageDir());
              setStorageDir(up);
              await loadStorageList(up);
            }}>Up</button>
            <button class="y-btn y-btn-sm" onClick=${() => loadStorageList(storageDir())}>Refresh</button>
            <span class="y-text-sm y-text-muted">${() => storageDirDisplay()}</span>
            <select
              class="storage-list y-input"
              ref=${(el: HTMLSelectElement) => { storageListEl = el; }}
              onChange=${() => { void handleStorageSelection(); }}
            >
              <option>Loading...</option>
            </select>
          </div>
          <span class="y-text-sm y-text-muted">${() => pdfStatus()}</span>
        </div>
        ${() => !hasPdf() ? html`
          <div
            class=${() => 'drop' + (isDragging() ? ' drag' : '')}
            onDragover=${(e: DragEvent) => { e.preventDefault(); setIsDragging(true); }}
            onDragleave=${() => setIsDragging(false)}
            onDrop=${(e: DragEvent) => {
              e.preventDefault();
              setIsDragging(false);
              const file = e.dataTransfer?.files?.[0];
              if (!file) return;
              if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
                setPdfStatus('Only PDF files are supported.');
                return;
              }
              showPdfUrl(URL.createObjectURL(file), file.name);
            }}
          >Drop a PDF file here, or use the file picker above.</div>
        ` : ''}
        ${() => hasPdf() ? html`
          <iframe
            class="viewer-frame"
            ref=${(el: HTMLIFrameElement) => { pdfFrameEl = el; }}
          ></iframe>
        ` : ''}
      </div>
    ` : ''}

    ${() => mode() === 'export' ? html`
      <div class="pane export-pane">
        <div class="export-left">
          <h3 style="margin: 0 0 8px;">Content</h3>
          <p class="y-text-xs y-text-muted" style="margin-top: 0;">Type plain text or basic HTML. Use preview, then click "Export PDF".</p>
          <textarea
            placeholder="Paste document/content here..."
            ref=${(el: HTMLTextAreaElement) => { contentInputEl = el; }}
          ></textarea>
        </div>
        <div class="export-right">
          <div style="display: flex; gap: 8px; margin-bottom: 10px;">
            <button class="y-btn y-btn-sm" onClick=${() => { renderPreview(); setGlobalStatus('Preview updated'); }}>Refresh Preview</button>
            <button class="y-btn y-btn-sm y-btn-primary" onClick=${() => { renderPreview(); setGlobalStatus('Opening print dialog... choose Save as PDF'); window.print(); }}>Export PDF</button>
            <button class="y-btn y-btn-sm" onClick=${async () => {
              renderPreview();
              try {
                await saveHtmlSnapshot();
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                setGlobalStatus(`Save failed: ${msg}`);
              }
            }}>Save HTML to Storage</button>
          </div>
          <div
            id="print-area"
            class="preview"
            ref=${(el: HTMLDivElement) => { printAreaEl = el; }}
          ></div>
        </div>
      </div>
    ` : ''}
  </div>
`, document.getElementById('app')!);

onMount(() => {
  // Initialise after DOM is ready
  if (contentInputEl) {
    contentInputEl.value = `<h1>Document Title</h1>\n<p>Write or paste your content here, then click <strong>Export PDF</strong>.</p>\n<ul><li>Supports plain text</li><li>Supports basic HTML</li></ul>`;
  }
  renderPreview();
  void loadStorageList('');
});

window.addEventListener('beforeunload', () => revokeCurrentPdfUrl());
