import { styles } from './styles';
import { STORAGE_KEY, countTextStats, debounce, downloadFile, nowLabel } from './utils';

const app = document.getElementById('app') || document.body;

app.innerHTML = `
  <style>${styles}</style>
  <div class="app-shell">
    <div class="topbar">
      <div class="brand"><span class="brand-badge">W</span> Word Lite</div>
      <div class="muted">Simple document editor</div>
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

const exec = (cmd: string, value?: string) => {
  editor.focus();
  document.execCommand(cmd, false, value);
  refreshStats();
};

const refreshStats = () => {
  const { words, chars } = countTextStats(editor.innerText || '');
  statsEl.textContent = `${words} words • ${chars} chars`;
};

const saveDoc = () => {
  localStorage.setItem(STORAGE_KEY, editor.innerHTML);
  saveState.textContent = `Saved at ${nowLabel()}`;
};

const autoSave = debounce(() => {
  saveDoc();
}, 550);

const loadDoc = () => {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    editor.innerHTML = stored;
    saveState.textContent = 'Loaded saved draft';
  } else {
    editor.innerHTML = '<h1>Untitled Document</h1><p></p>';
    saveState.textContent = 'New document';
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

document.getElementById('btn-export-txt')?.addEventListener('click', () => {
  downloadFile('document.txt', editor.innerText || '', 'text/plain;charset=utf-8');
});

document.getElementById('btn-export-html')?.addEventListener('click', () => {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Document</title></head><body>${editor.innerHTML}</body></html>`;
  downloadFile('document.html', html, 'text/html;charset=utf-8');
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
  refreshStats();
  saveState.textContent = `Opened ${file.name}`;
  saveDoc();
});

editor.addEventListener('input', () => {
  refreshStats();
  saveState.textContent = 'Editing…';
  autoSave();
});

editor.addEventListener('keyup', refreshStats);

document.addEventListener('keydown', (e) => {
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
        description: 'Append plain text to the document. Params: { text: string, newline?: boolean }',
        params: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            newline: { type: 'boolean' },
          },
          required: ['text'],
        },
        handler: (p: { text: string; newline?: boolean }) => {
          const existing = editor.innerText || '';
          const next = p.newline === false ? `${existing}${p.text}` : `${existing}${existing ? '\n' : ''}${p.text}`;
          setEditorFromPlainText(next);
          saveState.textContent = 'Updated via app protocol';
          saveDoc();
          return { ok: true };
        },
      },
      newDocument: {
        description: 'Clear current document to a blank paragraph. Params: {}',
        params: { type: 'object', properties: {} },
        handler: () => {
          editor.innerHTML = '<p></p>';
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
