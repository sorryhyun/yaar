import mammoth from '@bundled/mammoth';
import { marked } from '@bundled/marked';
import { downloadBlob, downloadFile, nowLabel, createDocxBlob } from './utils';
import { editorEl, docTitleEl, fileInputEl, focusMode, setFocusMode, setSaveStateText } from './state';
import { exec, refreshStats } from './editor';
import {
  saveDoc,
  autoSave,
  getTitle,
  exportBaseName,
} from './documents';

export const handleEditorInput = () => {
  refreshStats();
  setSaveStateText('Editing…');
  autoSave();
};

export const handleLink = () => {
  const link = prompt('Enter URL (https://...)');
  if (!link) return;
  exec('createLink', link);
};

export const handleNew = () => {
  if (!confirm('Start a new blank document?')) return;
  editorEl.innerHTML = '<p></p>';
  docTitleEl.value = 'Untitled Document';
  refreshStats();
  setSaveStateText('Unsaved new document');
  editorEl.focus();
};

export const handleOpen = () => { fileInputEl.value = ''; fileInputEl.click(); };

export const handleFocus = () => {
  setFocusMode(!focusMode());
  setSaveStateText(focusMode() ? 'Focus mode enabled' : 'Focus mode disabled');
};

export const handleExportTxt = () =>
  downloadFile(`${exportBaseName()}.txt`, editorEl.innerText || '', 'text/plain;charset=utf-8');

export const handleExportHtml = () => {
  const title = getTitle();
  const htmlContent = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${editorEl.innerHTML}</body></html>`;
  downloadFile(`${exportBaseName()}.html`, htmlContent, 'text/html;charset=utf-8');
};

export const handleExportDocx = () => {
  const blob = createDocxBlob(getTitle(), editorEl.innerText || '');
  downloadBlob(`${exportBaseName()}.docx`, blob);
  setSaveStateText(`Exported .docx at ${nowLabel()}`);
};

export const handleExportMd = () => {
  const title = getTitle();
  const text = editorEl.innerText || '';
  downloadFile(`${exportBaseName()}.md`, `# ${title}\n\n${text}`, 'text/markdown;charset=utf-8');
};

export const handleFileChange = async () => {
  const file = fileInputEl?.files?.[0];
  if (!file) return;

  if (/\.docx$/i.test(file.name)) {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const result = await mammoth.convertToHtml({ arrayBuffer });
      editorEl.innerHTML = result.value || '<p></p>';
    } catch (err) {
      editorEl.innerHTML = '<p>Failed to parse .docx file.</p>';
    }
  } else if (/\.md$/i.test(file.name)) {
    try {
      const text = await file.text();
      const html = await marked.parse(text);
      editorEl.innerHTML = html;
    } catch (err) {
      const text = await file.text();
      const escaped = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>');
      editorEl.innerHTML = `<p>${escaped}</p>`;
    }
  } else if (/\.html?$/i.test(file.name)) {
    const text = await file.text();
    editorEl.innerHTML = text;
  } else {
    const text = await file.text();
    const escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
    editorEl.innerHTML = `<p>${escaped}</p>`;
  }

  docTitleEl.value = file.name.replace(/\.[^/.]+$/, '') || 'Untitled Document';
  refreshStats();
  setSaveStateText(`Opened ${file.name}`);
  saveDoc();
};

export const tryOpenLink = (rawHref: string | null) => {
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

export const handleEditorClick = (e: MouseEvent) => {
  const linkEl = (e.target as HTMLElement)?.closest('a') as HTMLAnchorElement | null;
  if (!linkEl) return;
  e.preventDefault();
  tryOpenLink(linkEl.getAttribute('href'));
};
