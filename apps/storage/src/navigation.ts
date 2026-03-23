export {};
import { marked } from '@bundled/marked';
import Prism from '@bundled/prismjs';
import { currentPath, setCurrentPath, setEntries, setSelectedFile, setPreviewContent, setShowPreview, setStatusText, setPreviewTitleText, setPreviewMetaText, elPreviewBody } from './state';
import { basename, formatSize, isImage, isMarkdown, isPreviewable, getFileIcon, getExtension } from './helpers';
import { refreshMountAliases } from './mount-dialog';
import { storageList, storageRead, storageUrl } from './storage-api';

const EXT_LANG: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'tsx', jsx: 'jsx',
  py: 'python', css: 'css', scss: 'scss',
  html: 'html', xml: 'xml', svg: 'xml',
  json: 'json', yaml: 'yaml', yml: 'yaml',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  sql: 'sql', toml: 'toml', rs: 'rust',
  go: 'go', java: 'java', c: 'c', cpp: 'cpp',
  cs: 'csharp', rb: 'ruby', php: 'php',
};

const PREVIEW_UNAVAILABLE = '<span class="preview-unavailable">Unable to preview</span>';

export async function navigate(path: string) {
  setCurrentPath(path);
  setSelectedFile(null);
  setPreviewContent(null);
  setShowPreview(false);
  setStatusText('Loading...');
  try {
    await refreshMountAliases();
    const fetched = await storageList(path);
    fetched.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return basename(a.path).localeCompare(basename(b.path));
    });
    setEntries(() => fetched);
    const dirs = fetched.filter((e) => e.isDirectory).length;
    const files = fetched.length - dirs;
    setStatusText(`${files} file${files !== 1 ? 's' : ''}, ${dirs} folder${dirs !== 1 ? 's' : ''}`);
  } catch {
    setEntries(() => []);
    setStatusText('Error loading directory');
  }
}

export async function selectFile(entry: import('./types').StorageEntry) {
  const name = basename(entry.path);
  setSelectedFile(entry.path);
  setPreviewContent(null);
  setPreviewTitleText(name);
  setPreviewMetaText(formatSize(entry.size));
  setShowPreview(true);

  elPreviewBody.innerHTML = '<span class="preview-loading">Loading…</span>';

  if (isImage(name)) {
    // inline styles intentionally omitted — .preview-body img already covers max-width + border-radius
    elPreviewBody.innerHTML = `<img src="${storageUrl(entry.path)}" alt="${name}" />`;
    return;
  }

  const ext = getExtension(name);

  if (isMarkdown(name)) {
    try {
      const content = await storageRead(entry.path);
      setPreviewContent(content);
      const htmlContent = marked.parse(content) as string;
      elPreviewBody.innerHTML = `<div class="md-preview">${htmlContent}</div>`;
    } catch {
      elPreviewBody.innerHTML = PREVIEW_UNAVAILABLE;
    }
    return;
  }

  if (isPreviewable(name)) {
    try {
      const content = await storageRead(entry.path);
      setPreviewContent(content);

      const lang = EXT_LANG[ext] || 'clike';
      const grammar = (Prism.languages as any)[lang] ?? Prism.languages.clike;
      const highlighted = Prism.highlight(content, grammar, lang);

      elPreviewBody.innerHTML = `<pre class="code-preview language-${lang}"><code class="language-${lang}">${highlighted}</code></pre>`;
    } catch {
      elPreviewBody.innerHTML = PREVIEW_UNAVAILABLE;
    }
    return;
  }

  elPreviewBody.innerHTML = `
    <div class="no-preview-fallback">
      <div class="no-preview-icon">${getFileIcon(name, false)}</div>
      <div class="no-preview-text">No preview available</div>
      <button class="y-btn y-btn-sm" id="open-external">Open in browser tab ↗</button>
    </div>
  `;
  document.getElementById('open-external')?.addEventListener('click', () => {
    window.open(storageUrl(entry.path), '_blank');
  });
}

export function closePreview() {
  setSelectedFile(null);
  setPreviewContent(null);
  setShowPreview(false);
}
