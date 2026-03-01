import { signal, html, css, mount } from '@bundled/yaar';
import {
  countTextStats,
  createDocxBlob,
  debounce,
  downloadBlob,
  downloadFile,
  nowLabel,
  sanitizeFilename,
} from './utils';

// ── Styles (replaces styles.ts injection)
css`
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; background: var(--yaar-bg); }
  #app { height: 100%; }
  .app-shell { display: grid; grid-template-rows: auto auto 1fr auto; height: 100%; color: #e5e7eb; }
  .topbar { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: var(--yaar-bg-surface); border-bottom: 1px solid var(--yaar-border); }
  .brand { display: flex; align-items: center; gap: 8px; font-weight: 700; }
  .doc-meta { display: inline-flex; align-items: center; gap: 8px; }
  .doc-title-input { min-width: 220px; }
  .brand-badge { width: 26px; height: 26px; border-radius: 7px; background: linear-gradient(135deg, #3b82f6, #1d4ed8); display: inline-flex; align-items: center; justify-content: center; color: white; font-size: 13px; }
  .toolbar { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 12px; background: var(--yaar-bg-surface); border-bottom: 1px solid var(--yaar-border); }
  .group { display: inline-flex; gap: 6px; padding-right: 8px; margin-right: 4px; border-right: 1px solid var(--yaar-border); }
  .group:last-child { border-right: 0; padding-right: 0; }
  .editor-wrap { overflow: auto; padding: 24px; background: #0b1220; }
  .page { max-width: 860px; min-height: calc(100% - 4px); margin: 0 auto; background: #ffffff; border: 1px solid #e5e7eb; border-radius: 10px; box-shadow: 0 10px 24px rgba(0,0,0,0.22); color: #111827; padding: 36px 44px; outline: none; line-height: 1.5; font-size: 16px; cursor: text; }
  .page a, .page a:link, .page a:visited, .page a:hover, .page a:active, .page a:focus, .page a * { cursor: pointer !important; }
  .page a:hover { text-decoration: underline; }
  .page:empty:before { content: attr(data-placeholder); color: #9ca3af; }
  .statusbar { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: var(--yaar-bg-surface); border-top: 1px solid var(--yaar-border); color: var(--yaar-text-muted); }
  .app-shell.focus-mode .topbar, .app-shell.focus-mode .toolbar, .app-shell.focus-mode .statusbar { display: none; }
  .app-shell.focus-mode .editor-wrap { padding: 12px; }
  .muted { color: var(--yaar-text-muted); }
`;

// ── Reactive signals
const statsText = signal('0 words • 0 chars • 0 min read');
const saveStateText = signal('Not saved');
const focusMode = signal(false);

// ── DOM refs (assigned during mount via ref=)
let editorEl!: HTMLElement;
let docTitleEl!: HTMLInputElement;
let fileInputEl!: HTMLInputElement;
let formatBlockEl!: HTMLSelectElement;

// ── Storage
const yaarStorage = (window as any).yaar?.storage;
const DOC_PATH = 'word-lite/draft.json';

// ── Helpers
const getTitle = () => (docTitleEl?.value || '').trim() || 'Untitled Document';
const exportBaseName = () => sanitizeFilename(getTitle());

const refreshStats = () => {
  const { words, chars } = countTextStats(editorEl?.innerText || '');
  const readMins = words === 0 ? 0 : Math.max(1, Math.ceil(words / 200));
  statsText(`${words} words • ${chars} chars • ${readMins} min read`);
};

const exec = (cmd: string, value?: string) => {
  editorEl?.focus();
  document.execCommand(cmd, false, value);
  refreshStats();
};

const saveDoc = async () => {
  const payload = { html: editorEl?.innerHTML || '', title: getTitle(), savedAt: Date.now() };
  await yaarStorage?.save(DOC_PATH, JSON.stringify(payload));
  saveStateText(`Saved at ${nowLabel()}`);
};

const autoSave = debounce(() => saveDoc(), 550);

const loadDoc = async () => {
  const stored = await yaarStorage?.read(DOC_PATH, { as: 'text' }).catch(() => null);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as { html?: string; title?: string };
      editorEl.innerHTML = parsed.html || '<h1>Untitled Document</h1><p></p>';
      docTitleEl.value = parsed.title || 'Untitled Document';
    } catch {
      editorEl.innerHTML = '<h1>Untitled Document</h1><p></p>';
      docTitleEl.value = 'Untitled Document';
    }
    saveStateText('Loaded saved draft');
  } else {
    editorEl.innerHTML = '<h1>Untitled Document</h1><p></p>';
    docTitleEl.value = 'Untitled Document';
    saveStateText('New document');
  }
  refreshStats();
};

// ── Event handlers
const handleEditorInput = () => { refreshStats(); saveStateText('Editing…'); autoSave(); };

const handleLink = () => {
  const link = prompt('Enter URL (https://...)');
  if (!link) return;
  exec('createLink', link);
};

const handleNew = () => {
  if (!confirm('Start a new blank document?')) return;
  editorEl.innerHTML = '<p></p>';
  docTitleEl.value = 'Untitled Document';
  refreshStats();
  saveStateText('Unsaved new document');
  editorEl.focus();
};

const handleOpen = () => { fileInputEl.value = ''; fileInputEl.click(); };

const handleFocus = () => {
  focusMode(!focusMode());
  saveStateText(focusMode() ? 'Focus mode enabled' : 'Focus mode disabled');
};

const handleExportTxt = () => downloadFile(`${exportBaseName()}.txt`, editorEl.innerText || '', 'text/plain;charset=utf-8');
const handleExportHtml = () => {
  const title = getTitle();
  const htmlContent = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${editorEl.innerHTML}</body></html>`;
  downloadFile(`${exportBaseName()}.html`, htmlContent, 'text/html;charset=utf-8');
};
const handleExportDocx = () => {
  const blob = createDocxBlob(getTitle(), editorEl.innerText || '');
  downloadBlob(`${exportBaseName()}.docx`, blob);
  saveStateText(`Exported .docx at ${nowLabel()}`);
};

const handleFileChange = async () => {
  const file = fileInputEl?.files?.[0];
  if (!file) return;
  const text = await file.text();
  if (/\.html?$/i.test(file.name)) {
    editorEl.innerHTML = text;
  } else {
    const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
    editorEl.innerHTML = `<p>${escaped}</p>`;
  }
  docTitleEl.value = file.name.replace(/\.[^/.]+$/, '') || 'Untitled Document';
  refreshStats();
  saveStateText(`Opened ${file.name}`);
  saveDoc();
};

const tryOpenLink = (rawHref: string | null) => {
  if (!rawHref) return;
  try {
    const parsed = new URL(rawHref, window.location.href);
    if (!['http:', 'https:', 'mailto:', 'tel:'].includes(parsed.protocol)) {
      alert(`Unsupported link protocol: ${parsed.protocol}`);
      return;
    }
    window.open(parsed.href, '_blank', 'noopener,noreferrer');
  } catch { alert('Invalid URL'); }
};

const handleEditorClick = (e: MouseEvent) => {
  const linkEl = (e.target as HTMLElement)?.closest('a') as HTMLAnchorElement | null;
  if (!linkEl) return;
  e.preventDefault();
  tryOpenLink(linkEl.getAttribute('href'));
};

// ── Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && focusMode()) { focusMode(false); saveStateText('Focus mode disabled'); return; }
  if (!e.ctrlKey && !e.metaKey) return;
  const key = e.key.toLowerCase();
  if (key === 's') { e.preventDefault(); saveDoc(); }
  else if (key === 'b') { e.preventDefault(); exec('bold'); }
  else if (key === 'i') { e.preventDefault(); exec('italic'); }
  else if (key === 'u') { e.preventDefault(); exec('underline'); }
  else if (key === 'o') { e.preventDefault(); fileInputEl.value = ''; fileInputEl.click(); }
  else if (key === 'n') { e.preventDefault(); editorEl.innerHTML = '<p></p>'; docTitleEl.value = 'Untitled Document'; refreshStats(); saveStateText('Unsaved new document'); editorEl.focus(); }
});

// ── Mount
mount(html`
  <div class=${() => 'app-shell' + (focusMode() ? ' focus-mode' : '')}>
    <div class="topbar">
      <div class="brand"><span class="brand-badge">W</span> Word Lite</div>
      <div class="doc-meta">
        <label for="doc-title" class="muted">Title</label>
        <input
          id="doc-title"
          class="y-input doc-title-input"
          type="text"
          placeholder="Untitled Document"
          maxlength="100"
          ref=${(el: HTMLInputElement) => { docTitleEl = el; }}
          onInput=${() => { saveStateText('Editing title…'); autoSave(); }}
        />
      </div>
    </div>

    <div class="toolbar">
      <div class="group">
        <button class="y-btn y-btn-sm y-btn-ghost" onClick=${() => exec('bold')}><b>B</b></button>
        <button class="y-btn y-btn-sm y-btn-ghost" onClick=${() => exec('italic')}><i>I</i></button>
        <button class="y-btn y-btn-sm y-btn-ghost" onClick=${() => exec('underline')}><u>U</u></button>
      </div>
      <div class="group">
        <select
          class="y-input"
          title="Style"
          ref=${(el: HTMLSelectElement) => { formatBlockEl = el; }}
          onChange=${() => exec('formatBlock', formatBlockEl.value)}
        >
          <option value="P">Paragraph</option>
          <option value="H1">Heading 1</option>
          <option value="H2">Heading 2</option>
          <option value="H3">Heading 3</option>
          <option value="BLOCKQUOTE">Quote</option>
        </select>
      </div>
      <div class="group">
        <button class="y-btn y-btn-sm y-btn-ghost" onClick=${() => exec('justifyLeft')}>Left</button>
        <button class="y-btn y-btn-sm y-btn-ghost" onClick=${() => exec('justifyCenter')}>Center</button>
        <button class="y-btn y-btn-sm y-btn-ghost" onClick=${() => exec('justifyRight')}>Right</button>
        <button class="y-btn y-btn-sm y-btn-ghost" onClick=${() => exec('insertUnorderedList')}>• List</button>
        <button class="y-btn y-btn-sm y-btn-ghost" onClick=${() => exec('insertOrderedList')}>1. List</button>
      </div>
      <div class="group">
        <button class="y-btn y-btn-sm y-btn-ghost" onClick=${handleLink}>Link</button>
        <button class="y-btn y-btn-sm y-btn-ghost" onClick=${() => exec('removeFormat')}>Clear</button>
        <button class="y-btn y-btn-sm y-btn-ghost" onClick=${() => exec('undo')}>Undo</button>
        <button class="y-btn y-btn-sm y-btn-ghost" onClick=${() => exec('redo')}>Redo</button>
      </div>
      <div class="group">
        <button class="y-btn y-btn-sm y-btn-ghost" onClick=${handleNew}>New</button>
        <button class="y-btn y-btn-sm y-btn-ghost" onClick=${handleOpen}>Open</button>
        <button class="y-btn y-btn-sm y-btn-primary" onClick=${saveDoc}>Save</button>
        <button class="y-btn y-btn-sm y-btn-ghost" onClick=${handleExportTxt}>.txt</button>
        <button class="y-btn y-btn-sm y-btn-ghost" onClick=${handleExportHtml}>.html</button>
        <button class="y-btn y-btn-sm y-btn-ghost" onClick=${handleExportDocx}>.docx</button>
        <button class="y-btn y-btn-sm y-btn-ghost" onClick=${handleFocus}>Focus</button>
      </div>
    </div>

    <div class="editor-wrap">
      <article
        class="page"
        contenteditable="true"
        spellcheck="true"
        data-placeholder="Start typing..."
        ref=${(el: HTMLElement) => { editorEl = el; }}
        onInput=${handleEditorInput}
        onKeyup=${refreshStats}
        onClick=${handleEditorClick}
      ></article>
      <input
        type="file"
        accept=".txt,.html,.htm"
        style="display:none"
        ref=${(el: HTMLInputElement) => { fileInputEl = el; }}
        onChange=${handleFileChange}
      />
    </div>

    <div class="statusbar y-text-sm">
      <span>${() => statsText()}</span>
      <span>${() => saveStateText()}</span>
    </div>
  </div>
`);

// ref fires synchronously during mount — all elements are ready
loadDoc().then(() => editorEl.focus());

// ── App Protocol: expose state and commands to the AI agent ──────

const appApi = (window as any).yaar?.app;

function setEditorFromPlainText(text: string) {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
  editorEl.innerHTML = `<p>${escaped}</p>`;
  refreshStats();
}

function setEditorFromHtml(htmlStr: string) {
  editorEl.innerHTML = htmlStr || '<p></p>';
  refreshStats();
}

function appendHtmlFragment(htmlStr: string) {
  const div = document.createElement('div');
  div.innerHTML = htmlStr || '';
  while (div.firstChild) {
    editorEl.appendChild(div.firstChild);
  }
  refreshStats();
}

function extractBodyHtml(rawHtml: string) {
  const bodyMatch = rawHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return bodyMatch ? bodyMatch[1] : rawHtml;
}

type BatchDocInput = {
  title?: string;
  text?: string;
  html?: string;
};

function docsToMergedHtml(docs: BatchDocInput[]) {
  if (!docs.length) return '<p></p>';

  return docs
    .map((doc, index) => {
      const rawTitle = (doc.title || '').trim() || `Document ${index + 1}`;
      const safeTitle = rawTitle
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

      if (typeof doc.html === 'string') {
        return `<section><h2>${safeTitle}</h2>${doc.html}</section>`;
      }

      const escapedText = (doc.text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>');
      return `<section><h2>${safeTitle}</h2><p>${escapedText}</p></section>`;
    })
    .join('');
}

if (appApi) {
  appApi.register({
    appId: 'word-lite',
    name: 'Word Lite',
    state: {
      html: {
        description: 'Current document HTML content',
        handler: () => editorEl.innerHTML,
      },
      text: {
        description: 'Current document plain text content',
        handler: () => editorEl.innerText || '',
      },
      stats: {
        description: 'Current text stats as { words, chars }',
        handler: () => countTextStats(editorEl.innerText || ''),
      },
      title: {
        description: 'Current document title',
        handler: () => getTitle(),
      },
      saveState: {
        description: 'Current save status label',
        handler: () => saveStateText(),
      },
    },
    commands: {
      setHtml: {
        description: 'Replace document with HTML. Params: { html: string }',
        params: {
          type: 'object',
          properties: { html: { type: 'string' } },
          required: ['html'],
        },
        handler: (p: { html: string }) => {
          setEditorFromHtml(p.html || '<p></p>');
          saveStateText('Updated via app protocol');
          saveDoc();
          return { ok: true };
        },
      },
      setTitle: {
        description: 'Update document title. Params: { title: string }',
        params: {
          type: 'object',
          properties: { title: { type: 'string' } },
          required: ['title'],
        },
        handler: (p: { title: string }) => {
          docTitleEl.value = (p.title || '').trim() || 'Untitled Document';
          saveStateText('Updated via app protocol');
          saveDoc();
          return { ok: true };
        },
      },
      setText: {
        description: 'Replace document with plain text. Params: { text: string }',
        params: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
        handler: (p: { text: string }) => {
          setEditorFromPlainText(p.text || '');
          saveStateText('Updated via app protocol');
          saveDoc();
          return { ok: true };
        },
      },
      appendText: {
        description: 'Append plain text as a new paragraph to the document. Params: { text: string }',
        params: {
          type: 'object',
          properties: {
            text: { type: 'string' },
          },
          required: ['text'],
        },
        handler: (p: { text: string }) => {
          const escaped = (p.text || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\n/g, '<br>');
          const para = document.createElement('p');
          para.innerHTML = escaped;
          editorEl.appendChild(para);
          refreshStats();
          saveStateText('Updated via app protocol');
          saveDoc();
          return { ok: true };
        },
      },
      appendHtml: {
        description: 'Append HTML content to the end of the document without replacing existing content. Params: { html: string }',
        params: {
          type: 'object',
          properties: { html: { type: 'string' } },
          required: ['html'],
        },
        handler: (p: { html: string }) => {
          appendHtmlFragment(p.html || '');
          saveStateText('Updated via app protocol');
          saveDoc();
          return { ok: true };
        },
      },
      setDocuments: {
        description: 'Replace the editor with multiple documents at once. Params: { docs: Array<{ title?: string, text?: string, html?: string }> }',
        params: {
          type: 'object',
          properties: {
            docs: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  text: { type: 'string' },
                  html: { type: 'string' },
                },
              },
            },
          },
          required: ['docs'],
        },
        handler: (p: { docs: BatchDocInput[] }) => {
          const docs = Array.isArray(p.docs) ? p.docs : [];
          setEditorFromHtml(docsToMergedHtml(docs));
          saveStateText(`Loaded ${docs.length} document(s) via app protocol`);
          saveDoc();
          return { ok: true, count: docs.length };
        },
      },
      appendDocuments: {
        description: 'Append multiple documents to the current editor. Params: { docs: Array<{ title?: string, text?: string, html?: string }> }',
        params: {
          type: 'object',
          properties: {
            docs: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  text: { type: 'string' },
                  html: { type: 'string' },
                },
              },
            },
          },
          required: ['docs'],
        },
        handler: (p: { docs: BatchDocInput[] }) => {
          const docs = Array.isArray(p.docs) ? p.docs : [];
          appendHtmlFragment(docsToMergedHtml(docs));
          saveStateText(`Appended ${docs.length} document(s) via app protocol`);
          saveDoc();
          return { ok: true, count: docs.length };
        },
      },
      saveToStorage: {
        description: 'Save the current document to YAAR persistent storage. Params: { path: string } — e.g. "docs/my-doc.html"',
        params: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        handler: async (p: { path: string }) => {
          const storage = (window as any).yaar?.storage;
          if (!storage) return { ok: false, error: 'Storage API not available' };
          const title = getTitle();
          const htmlContent = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${editorEl.innerHTML}</body></html>`;
          await storage.save(p.path, htmlContent);
          saveStateText(`Saved to storage: ${p.path}`);
          return { ok: true, path: p.path, savedAt: nowLabel() };
        },
      },
      loadFromStorage: {
        description: 'Load one or many documents from YAAR storage. Params: { path?: string, paths?: string[], mode?: "replace"|"append" }',
        params: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            paths: { type: 'array', items: { type: 'string' } },
            mode: { type: 'string', enum: ['replace', 'append'] },
          },
        },
        handler: async (p: { path?: string; paths?: string[]; mode?: 'replace' | 'append' }) => {
          const storage = (window as any).yaar?.storage;
          if (!storage) return { ok: false, error: 'Storage API not available' };

          const candidatePaths = [
            ...(p.path ? [p.path] : []),
            ...(Array.isArray(p.paths) ? p.paths : []),
          ].filter((v): v is string => typeof v === 'string' && v.trim().length > 0);

          if (!candidatePaths.length) {
            return { ok: false, error: 'Provide path or paths' };
          }

          const loadedDocs: BatchDocInput[] = [];
          for (const path of candidatePaths) {
            const raw: string = await storage.read(path, { as: 'text' });
            const body = extractBodyHtml(raw);
            const filename = path.split('/').pop() || path;
            const title = filename.replace(/\.[^/.]+$/, '') || 'Untitled Document';
            loadedDocs.push({ title, html: body });
          }

          const mode = p.mode || 'replace';
          const merged = docsToMergedHtml(loadedDocs);
          if (mode === 'append') {
            appendHtmlFragment(merged);
          } else {
            setEditorFromHtml(merged);
          }

          saveStateText(`Loaded ${loadedDocs.length} file(s) from storage`);
          saveDoc();
          return { ok: true, count: loadedDocs.length, paths: candidatePaths, mode };
        },
      },
      readStorageFile: {
        description: 'Read one file from YAAR storage without mutating the editor. Params: { path: string, as?: "text"|"json"|"auto" }',
        params: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            as: { type: 'string', enum: ['text', 'json', 'auto'] },
          },
          required: ['path'],
        },
        handler: async (p: { path: string; as?: 'text' | 'json' | 'auto' }) => {
          const storage = (window as any).yaar?.storage;
          if (!storage) return { ok: false, error: 'Storage API not available' };
          const readAs = p.as || 'text';
          const content = await storage.read(p.path, { as: readAs });
          return { ok: true, path: p.path, as: readAs, content };
        },
      },
      readStorageFiles: {
        description: 'Read multiple files from YAAR storage without mutating the editor. Params: { paths: string[], as?: "text"|"json"|"auto" }',
        params: {
          type: 'object',
          properties: {
            paths: { type: 'array', items: { type: 'string' } },
            as: { type: 'string', enum: ['text', 'json', 'auto'] },
          },
          required: ['paths'],
        },
        handler: async (p: { paths: string[]; as?: 'text' | 'json' | 'auto' }) => {
          const storage = (window as any).yaar?.storage;
          if (!storage) return { ok: false, error: 'Storage API not available' };

          const paths = (Array.isArray(p.paths) ? p.paths : []).filter(
            (v): v is string => typeof v === 'string' && v.trim().length > 0,
          );
          const readAs = p.as || 'text';

          const files = await Promise.all(
            paths.map(async (path) => ({
              path,
              content: await storage.read(path, { as: readAs }),
            })),
          );

          return { ok: true, as: readAs, files };
        },
      },
      newDocument: {
        description: 'Clear current document to a blank paragraph. Params: {}',
        params: { type: 'object', properties: {} },
        handler: () => {
          editorEl.innerHTML = '<p></p>';
          docTitleEl.value = 'Untitled Document';
          refreshStats();
          saveStateText('Unsaved new document');
          return { ok: true };
        },
      },
      saveDraft: {
        description: 'Save current document to local draft storage. Params: {}',
        params: { type: 'object', properties: {} },
        handler: () => {
          saveDoc();
          return { ok: true, savedAt: nowLabel() };
        },
      },
    },
  });
}
