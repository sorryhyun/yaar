import { nowLabel, sanitizeFilename } from './utils';
import { editorEl, docTitleEl, saveStateText } from './state';
import { refreshStats } from './editor';
import { debounce } from './utils';

export const STORAGE_KEY = 'word-lite/draft.json';

const yaarStorage = (window as any).yaar?.storage;

export const getTitle = () => (docTitleEl?.value || '').trim() || 'Untitled Document';
export const exportBaseName = () => sanitizeFilename(getTitle());

export const saveDoc = async () => {
  const payload = { html: editorEl?.innerHTML || '', title: getTitle(), savedAt: Date.now() };
  await yaarStorage?.save(STORAGE_KEY, JSON.stringify(payload));
  saveStateText(`Saved at ${nowLabel()}`);
};

export const autoSave = debounce(() => saveDoc(), 550);

export const loadDoc = async () => {
  const stored = await yaarStorage?.read(STORAGE_KEY, { as: 'text' }).catch(() => null);
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

// ── Document HTML helpers (used by handlers and protocol)

export function setEditorFromPlainText(text: string) {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
  editorEl.innerHTML = `<p>${escaped}</p>`;
  refreshStats();
}

export function setEditorFromHtml(htmlStr: string) {
  editorEl.innerHTML = htmlStr || '<p></p>';
  refreshStats();
}

export function appendHtmlFragment(htmlStr: string) {
  const div = document.createElement('div');
  div.innerHTML = htmlStr || '';
  while (div.firstChild) {
    editorEl.appendChild(div.firstChild);
  }
  refreshStats();
}

export function extractBodyHtml(rawHtml: string) {
  const bodyMatch = rawHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return bodyMatch ? bodyMatch[1] : rawHtml;
}

export type BatchDocInput = {
  title?: string;
  text?: string;
  html?: string;
};

export function docsToMergedHtml(docs: BatchDocInput[]) {
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
