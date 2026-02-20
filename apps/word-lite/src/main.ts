import { styles } from './styles';
import {
  LEGACY_STORAGE_KEY,
  STORAGE_KEY,
  countTextStats,
  createDocxBlob,
  debounce,
  downloadBlob,
  downloadFile,
  nowLabel,
  sanitizeFilename,
} from './utils';

const app = document.getElementById('app') || document.body;

app.innerHTML = `
  <style>${styles}</style>
  <div class="app-shell">
    <div class="topbar">
      <div class="brand"><span class="brand-badge">W</span> Word Lite</div>
      <div class="doc-meta">
        <label for="doc-title" class="muted">Title</label>
        <input id="doc-title" type="text" placeholder="Untitled Document" maxlength="100" />
      </div>
    </div>

    <div class="toolbar">
      <div class="group">
        <button data-cmd="bold"><b>B</b></button>
        <button data-cmd="italic"><i>I</i></button>
        <button data-cmd="underline"><u>U</u></button>
      </div>

      <div class="group">
        <select id="format-block" title="Style">
          <option value="P">Paragraph</option>
          <option value="H1">Heading 1</option>
          <option value="H2">Heading 2</option>
          <option value="H3">Heading 3</option>
          <option value="BLOCKQUOTE">Quote</option>
        </select>
      </div>

      <div class="group">
        <button data-cmd="justifyLeft">Left</button>
        <button data-cmd="justifyCenter">Center</button>
        <button data-cmd="justifyRight">Right</button>
        <button data-cmd="insertUnorderedList">• List</button>
        <button data-cmd="insertOrderedList">1. List</button>
      </div>

      <div class="group">
        <button id="btn-link">Link</button>
        <button data-cmd="removeFormat">Clear</button>
        <button data-cmd="undo">Undo</button>
        <button data-cmd="redo">Redo</button>
      </div>

      <div class="group">
        <button id="btn-new">New</button>
        <button id="btn-open">Open</button>
        <button id="btn-save" class="primary">Save</button>
        <button id="btn-export-txt">.txt</button>
        <button id="btn-export-html">.html</button>
        <button id="btn-export-docx">.docx</button>
        <button id="btn-focus">Focus</button>
      </div>
    </div>

    <div class="editor-wrap">
      <article id="editor" class="page" contenteditable="true" spellcheck="true" data-placeholder="Start typing..."></article>
      <input id="file-input" type="file" accept=".txt,.html,.htm" style="display:none" />
    </div>

    <div class="statusbar">
      <span id="stats">0 words • 0 chars</span>
      <span id="save-state">Not saved</span>
    </div>
  </div>
`;

const editor = document.getElementById('editor') as HTMLElement;
const fileInput = document.getElementById('file-input') as HTMLInputElement;
const statsEl = document.getElementById('stats') as HTMLSpanElement;
const saveState = document.getElementById('save-state') as HTMLSpanElement;
const formatBlock = document.getElementById('format-block') as HTMLSelectElement;
const docTitle = document.getElementById('doc-title') as HTMLInputElement;

let isFocusMode = false;

const getTitle = () => (docTitle.value || '').trim() || 'Untitled Document';
const exportBaseName = () => sanitizeFilename(getTitle());

const exec = (cmd: string, value?: string) => {
  editor.focus();
  document.execCommand(cmd, false, value);
  refreshStats();
};

const refreshStats = () => {
  const { words, chars } = countTextStats(editor.innerText || '');
  const readMins = words === 0 ? 0 : Math.max(1, Math.ceil(words / 200));
  statsEl.textContent = `${words} words • ${chars} chars • ${readMins} min read`;
};

const saveDoc = () => {
  const payload = {
    html: editor.innerHTML,
    title: getTitle(),
    savedAt: Date.now(),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  saveState.textContent = `Saved at ${nowLabel()}`;
};

const autoSave = debounce(() => {
  saveDoc();
}, 550);

const loadDoc = () => {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as { html?: string; title?: string };
      editor.innerHTML = parsed.html || '<h1>Untitled Document</h1><p></p>';
      docTitle.value = parsed.title || 'Untitled Document';
    } catch {
      editor.innerHTML = stored;
      docTitle.value = 'Untitled Document';
    }
    saveState.textContent = 'Loaded saved draft';
  } else {
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy) {
      editor.innerHTML = legacy;
      docTitle.value = 'Untitled Document';
      saveState.textContent = 'Loaded saved draft';
      saveDoc();
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    } else {
      editor.innerHTML = '<h1>Untitled Document</h1><p></p>';
      docTitle.value = 'Untitled Document';
      saveState.textContent = 'New document';
    }
  }
  refreshStats();
};

for (const btn of Array.from(document.querySelectorAll('button[data-cmd]'))) {
  btn.addEventListener('click', () => {
    const cmd = (btn as HTMLButtonElement).dataset.cmd!;
    exec(cmd);
  });
}

formatBlock.addEventListener('change', () => {
  exec('formatBlock', formatBlock.value);
});

document.getElementById('btn-link')?.addEventListener('click', () => {
  const link = prompt('Enter URL (https://...)');
  if (!link) return;
  exec('createLink', link);
});

document.getElementById('btn-new')?.addEventListener('click', () => {
  const ok = confirm('Start a new blank document?');
  if (!ok) return;
  editor.innerHTML = '<p></p>';
  docTitle.value = 'Untitled Document';
  refreshStats();
  saveState.textContent = 'Unsaved new document';
  editor.focus();
});

document.getElementById('btn-open')?.addEventListener('click', () => {
  fileInput.value = '';
  fileInput.click();
});

document.getElementById('btn-save')?.addEventListener('click', () => {
  saveDoc();
});

document.getElementById('btn-focus')?.addEventListener('click', () => {
  isFocusMode = !isFocusMode;
  app.classList.toggle('focus-mode', isFocusMode);
  saveState.textContent = isFocusMode ? 'Focus mode enabled' : 'Focus mode disabled';
});

document.getElementById('btn-export-txt')?.addEventListener('click', () => {
  downloadFile(`${exportBaseName()}.txt`, editor.innerText || '', 'text/plain;charset=utf-8');
});

document.getElementById('btn-export-html')?.addEventListener('click', () => {
  const title = getTitle();
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${editor.innerHTML}</body></html>`;
  downloadFile(`${exportBaseName()}.html`, html, 'text/html;charset=utf-8');
});

document.getElementById('btn-export-docx')?.addEventListener('click', () => {
  const blob = createDocxBlob(getTitle(), editor.innerText || '');
  downloadBlob(`${exportBaseName()}.docx`, blob);
  saveState.textContent = `Exported .docx at ${nowLabel()}`;
});

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  const text = await file.text();
  if (/\.html?$/i.test(file.name)) {
    editor.innerHTML = text;
  } else {
    const escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
    editor.innerHTML = `<p>${escaped}</p>`;
  }
  docTitle.value = file.name.replace(/\.[^/.]+$/, '') || 'Untitled Document';
  refreshStats();
  saveState.textContent = `Opened ${file.name}`;
  saveDoc();
});

editor.addEventListener('input', () => {
  refreshStats();
  saveState.textContent = 'Editing…';
  autoSave();
});

docTitle.addEventListener('input', () => {
  saveState.textContent = 'Editing title…';
  autoSave();
});

editor.addEventListener('keyup', refreshStats);

const tryOpenLink = (rawHref: string | null) => {
  if (!rawHref) return;
  try {
    const parsed = new URL(rawHref, window.location.href);
    const allowed = ['http:', 'https:', 'mailto:', 'tel:'];
    if (!allowed.includes(parsed.protocol)) {
      alert(`Unsupported link protocol: ${parsed.protocol}`);
      return;
    }
    window.open(parsed.href, '_blank', 'noopener,noreferrer');
  } catch {
    alert('Invalid URL');
  }
};

editor.addEventListener('click', (e) => {
  const target = e.target as HTMLElement | null;
  const linkEl = target?.closest('a') as HTMLAnchorElement | null;
  if (!linkEl) return;

  e.preventDefault();
  tryOpenLink(linkEl.getAttribute('href'));
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isFocusMode) {
    isFocusMode = false;
    app.classList.remove('focus-mode');
    saveState.textContent = 'Focus mode disabled';
    return;
  }

  if (!e.ctrlKey && !e.metaKey) return;
  const key = e.key.toLowerCase();
  if (key === 's') {
    e.preventDefault();
    saveDoc();
  } else if (key === 'b') {
    e.preventDefault();
    exec('bold');
  } else if (key === 'i') {
    e.preventDefault();
    exec('italic');
  } else if (key === 'u') {
    e.preventDefault();
    exec('underline');
  } else if (key === 'o') {
    e.preventDefault();
    fileInput.value = '';
    fileInput.click();
  } else if (key === 'n') {
    e.preventDefault();
    editor.innerHTML = '<p></p>';
    docTitle.value = 'Untitled Document';
    refreshStats();
    saveState.textContent = 'Unsaved new document';
    editor.focus();
  }
});

loadDoc();
editor.focus();

// ── App Protocol: expose state and commands to the AI agent ──────

const appApi = (window as any).yaar?.app;

function setEditorFromPlainText(text: string) {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
  editor.innerHTML = `<p>${escaped}</p>`;
  refreshStats();
}

if (appApi) {
  appApi.register({
    appId: 'word-lite',
    name: 'Word Lite',
    state: {
      html: {
        description: 'Current document HTML content',
        handler: () => editor.innerHTML,
      },
      text: {
        description: 'Current document plain text content',
        handler: () => editor.innerText || '',
      },
      stats: {
        description: 'Current text stats as { words, chars }',
        handler: () => countTextStats(editor.innerText || ''),
      },
      title: {
        description: 'Current document title',
        handler: () => getTitle(),
      },
      saveState: {
        description: 'Current save status label',
        handler: () => saveState.textContent || '',
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
          editor.innerHTML = p.html || '<p></p>';
          refreshStats();
          saveState.textContent = 'Updated via app protocol';
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
          docTitle.value = (p.title || '').trim() || 'Untitled Document';
          saveState.textContent = 'Updated via app protocol';
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
          saveState.textContent = 'Updated via app protocol';
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
          editor.appendChild(para);
          refreshStats();
          saveState.textContent = 'Updated via app protocol';
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
          const div = document.createElement('div');
          div.innerHTML = p.html || '';
          while (div.firstChild) {
            editor.appendChild(div.firstChild);
          }
          refreshStats();
          saveState.textContent = 'Updated via app protocol';
          saveDoc();
          return { ok: true };
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
          const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${editor.innerHTML}</body></html>`;
          await storage.save(p.path, html);
          saveState.textContent = `Saved to storage: ${p.path}`;
          return { ok: true, path: p.path, savedAt: nowLabel() };
        },
      },
      loadFromStorage: {
        description: 'Load a document from YAAR persistent storage into the editor. Params: { path: string }',
        params: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        handler: async (p: { path: string }) => {
          const storage = (window as any).yaar?.storage;
          if (!storage) return { ok: false, error: 'Storage API not available' };
          const html: string = await storage.read(p.path, { as: 'text' });
          // Strip outer HTML boilerplate if present, just use body content
          const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
          editor.innerHTML = bodyMatch ? bodyMatch[1] : html;
          refreshStats();
          saveState.textContent = `Loaded from storage: ${p.path}`;
          saveDoc();
          return { ok: true, path: p.path };
        },
      },
      newDocument: {
        description: 'Clear current document to a blank paragraph. Params: {}',
        params: { type: 'object', properties: {} },
        handler: () => {
          editor.innerHTML = '<p></p>';
          docTitle.value = 'Untitled Document';
          refreshStats();
          saveState.textContent = 'Unsaved new document';
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
