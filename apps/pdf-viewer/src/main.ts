type Mode = 'viewer' | 'export';

const root = document.getElementById('app');
if (!root) throw new Error('Missing app root');

root.innerHTML = `
  <style>
    :root {
      color-scheme: light dark;
      font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    }
    body { margin: 0; }
    .wrap { display: grid; grid-template-rows: auto 1fr; height: 100vh; }
    .top {
      display: flex;
      gap: 8px;
      align-items: center;
      padding: 10px;
      border-bottom: 1px solid #d0d7de;
      background: #f6f8fa;
      flex-wrap: wrap;
    }
    .top button, .top select, .top input, .top textarea {
      font: inherit;
    }
    .top button {
      padding: 6px 10px;
      border: 1px solid #b6c2cf;
      border-radius: 8px;
      background: white;
      cursor: pointer;
    }
    .top button.active { background: #0969da; color: #fff; border-color: #0969da; }
    .top .spacer { flex: 1; }
    .pane { height: calc(100vh - 58px); }
    .hidden { display: none !important; }
    .viewer-pane { display: grid; grid-template-rows: auto 1fr; }
    .viewer-controls {
      display: flex;
      gap: 8px;
      padding: 10px;
      border-bottom: 1px solid #d0d7de;
      align-items: center;
      flex-wrap: wrap;
    }
    .viewer-frame {
      width: 100%;
      height: 100%;
      border: 0;
      background: #f0f0f0;
    }
    .drop {
      border: 2px dashed #9aa4b2;
      border-radius: 12px;
      padding: 28px;
      margin: 12px;
      text-align: center;
      color: #57606a;
    }
    .drop.drag { border-color: #0969da; color: #0969da; }
    .export-pane { display: grid; grid-template-columns: 1fr 1fr; height: 100%; }
    .left, .right { padding: 10px; overflow: auto; }
    .left { border-right: 1px solid #d0d7de; }
    textarea {
      width: 100%;
      height: calc(100% - 60px);
      min-height: 220px;
      resize: vertical;
      border: 1px solid #d0d7de;
      border-radius: 8px;
      padding: 10px;
      box-sizing: border-box;
      background: white;
      color: #111;
    }
    .preview {
      background: white;
      border: 1px solid #d0d7de;
      border-radius: 8px;
      padding: 20px;
      min-height: 92%;
      color: #111;
    }
    .hint { color: #57606a; font-size: 12px; }
    .status { font-size: 12px; color: #57606a; }
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
    <div class="top">
      <button id="btn-viewer" class="active">PDF Viewer</button>
      <button id="btn-export">Export to PDF</button>
      <div class="spacer"></div>
      <span id="global-status" class="status">Ready</span>
    </div>

    <div id="viewer-pane" class="pane viewer-pane">
      <div class="viewer-controls">
        <input id="file-input" type="file" accept="application/pdf" />
        <button id="open-storage">Open from Storage Path</button>
        <input id="storage-path" type="text" placeholder="e.g. mydocs/report.pdf" style="min-width: 260px; padding: 6px 8px; border-radius: 8px; border: 1px solid #d0d7de;" />
        <button id="clear-pdf">Clear</button>
        <span id="pdf-status" class="status">No PDF loaded.</span>
      </div>
      <div id="drop" class="drop">Drop a PDF file here, or use the file picker above.</div>
      <iframe id="pdf-frame" class="viewer-frame hidden"></iframe>
    </div>

    <div id="export-pane" class="pane export-pane hidden">
      <div class="left">
        <h3 style="margin: 0 0 8px;">Content</h3>
        <p class="hint" style="margin-top: 0;">Type plain text or basic HTML. Use preview, then click “Export PDF”.</p>
        <textarea id="content-input" placeholder="Paste document/content here..."></textarea>
      </div>
      <div class="right">
        <div style="display: flex; gap: 8px; margin-bottom: 10px;">
          <button id="preview-btn">Refresh Preview</button>
          <button id="export-btn">Export PDF</button>
          <button id="save-html-btn">Save HTML to Storage</button>
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
  openStorage: document.getElementById('open-storage') as HTMLButtonElement,
  storagePath: document.getElementById('storage-path') as HTMLInputElement,
  contentInput: document.getElementById('content-input') as HTMLTextAreaElement,
  previewBtn: document.getElementById('preview-btn') as HTMLButtonElement,
  exportBtn: document.getElementById('export-btn') as HTMLButtonElement,
  saveHtmlBtn: document.getElementById('save-html-btn') as HTMLButtonElement,
  printArea: document.getElementById('print-area') as HTMLDivElement,
};

let mode: Mode = 'viewer';
let currentPdfUrl: string | null = null;

function setMode(next: Mode) {
  mode = next;
  const viewer = next === 'viewer';
  els.viewerPane.classList.toggle('hidden', !viewer);
  els.exportPane.classList.toggle('hidden', viewer);
  els.btnViewer.classList.toggle('active', viewer);
  els.btnExport.classList.toggle('active', !viewer);
  els.globalStatus.textContent = viewer ? 'Viewer mode' : 'Export mode';
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
  const clean = path.trim().replace(/^\/+/, '');
  if (!clean) {
    els.pdfStatus.textContent = 'Enter a storage path first.';
    return;
  }
  // Runtime storage API from YAAR
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const storage = (window as any).yaar?.storage;
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const storage = (window as any).yaar?.storage;
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

els.openStorage.addEventListener('click', () => openFromStorage(els.storagePath.value));
els.storagePath.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') openFromStorage(els.storagePath.value);
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

window.addEventListener('beforeunload', () => revokeCurrentPdfUrl());
