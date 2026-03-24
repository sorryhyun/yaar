import { appStorage, createPersistedSignal } from '@bundled/yaar';
import { nowLabel, sanitizeFilename, debounce, textToHtml, DEFAULT_TITLE } from './utils';
import { editorEl, docTitleEl, setSaveStateText } from './state';
import { refreshStats } from './editor';

export const STORAGE_KEY = 'draft.json';

type DraftState = { html: string; title: string; savedAt: number };
const EMPTY_DRAFT: DraftState = {
  html: `<h1>${DEFAULT_TITLE}</h1><p></p>`,
  title: DEFAULT_TITLE,
  savedAt: 0,
};

// Signal: auto-persists to storage on every setDraft() call.
// Replaces the old window.yaar.invoke pattern for saves.
const [, setDraft] = createPersistedSignal<DraftState>(STORAGE_KEY, EMPTY_DRAFT);

export const getTitle = () => (docTitleEl?.value || '').trim() || DEFAULT_TITLE;
export const exportBaseName = () => sanitizeFilename(getTitle());

/** Save current editor content. Synchronous — setDraft handles async persistence. */
export const saveDoc = () => {
  setDraft({ html: editorEl?.innerHTML || '', title: getTitle(), savedAt: Date.now() });
  setSaveStateText(`Saved at ${nowLabel()}`);
};

export const autoSave = debounce(() => saveDoc(), 550);

/** Load persisted draft into the editor on startup. */
export const loadDoc = async () => {
  const stored = await appStorage.readJsonOr<DraftState>(STORAGE_KEY, EMPTY_DRAFT);
  if (stored.savedAt > 0) {
    editorEl.innerHTML = stored.html || `<h1>${DEFAULT_TITLE}</h1><p></p>`;
    docTitleEl.value = stored.title || DEFAULT_TITLE;
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
