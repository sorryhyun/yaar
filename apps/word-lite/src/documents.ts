import { nowLabel, sanitizeFilename, debounce, textToHtml, DEFAULT_TITLE } from './utils';
import { editorEl, docTitleEl, setSaveStateText } from './state';
import { refreshStats } from './editor';

export const STORAGE_KEY = 'draft.json';

const _yaar = (window as any).yaar;

async function storageSave(path: string, content: string): Promise<void> {
  await _yaar.invoke(`yaar://apps/self/storage/${path}`, { action: 'write', content });
}

async function storageRead(path: string, as: 'text' | 'json' = 'text'): Promise<any> {
  const result = await _yaar.read(`yaar://apps/self/storage/${path}`);
  if (typeof result === 'string') return as === 'json' ? JSON.parse(result) : result;
  return as === 'json' ? result : JSON.stringify(result);
}

export const getTitle = () => (docTitleEl?.value || '').trim() || DEFAULT_TITLE;
export const exportBaseName = () => sanitizeFilename(getTitle());

export const saveDoc = async () => {
  const payload = { html: editorEl?.innerHTML || '', title: getTitle(), savedAt: Date.now() };
  await storageSave(STORAGE_KEY, JSON.stringify(payload));
  setSaveStateText(`Saved at ${nowLabel()}`);
};

export const autoSave = debounce(() => saveDoc(), 550);

export const loadDoc = async () => {
  const stored = await storageRead(STORAGE_KEY, 'text').catch(() => null);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as { html?: string; title?: string };
      editorEl.innerHTML = parsed.html || `<h1>${DEFAULT_TITLE}</h1><p></p>`;
      docTitleEl.value = parsed.title || DEFAULT_TITLE;
    } catch {
      editorEl.innerHTML = `<h1>${DEFAULT_TITLE}</h1><p></p>`;
      docTitleEl.value = DEFAULT_TITLE;
    }
    setSaveStateText('Loaded saved draft');
  } else {
    editorEl.innerHTML = `<h1>${DEFAULT_TITLE}</h1><p></p>`;
    docTitleEl.value = DEFAULT_TITLE;
    setSaveStateText('New document');
  }
  refreshStats();
};

// ── Document HTML helpers (used by handlers and protocol)

export function setEditorFromPlainText(text: string) {
  editorEl.innerHTML = `<p>${textToHtml(text)}</p>`;
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

      return `<section><h2>${safeTitle}</h2><p>${textToHtml(doc.text || '')}</p></section>`;
    })
    .join('');
}
