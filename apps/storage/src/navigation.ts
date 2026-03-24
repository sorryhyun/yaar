export {};
import { marked } from '@bundled/marked';
import Prism from '@bundled/prismjs';
import { storage } from '@bundled/yaar';
import { state, setState, elPreviewBody } from './state';
import { basename, formatSize, isImage, isMarkdown, isPreviewable, getFileIcon, getExtension } from './helpers';
import { refreshMountAliases } from './mount-dialog';

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
  setState('currentPath', path);
  setState('selectedFile', null);
  setState('previewContent', null);
  setState('showPreview', false);
  setState('statusText', 'Loading...');
  try {
    await refreshMountAliases();
    const fetched = await storage.list(path) as unknown as import('./types').StorageEntry[];
    fetched.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return basename(a.path).localeCompare(basename(b.path));
    });
    setState('entries', fetched);
    const dirs = fetched.filter((e) => e.isDirectory).length;
    const files = fetched.length - dirs;
    setState('statusText', `${files} file${files !== 1 ? 's' : ''}, ${dirs} folder${dirs !== 1 ? 's' : ''}`);
  } catch {
    setState('entries', []);
    setState('statusText', 'Error loading directory');
  }
}

export async function selectFile(entry: import('./types').StorageEntry) {
  const name = basename(entry.path);
  setState('selectedFile', entry.path);
  setState('previewContent', null);
  setState('previewTitleText', name);
  setState('previewMetaText', formatSize(entry.size));
  setState('showPreview', true);

  elPreviewBody.innerHTML = '<span class="preview-loading">Loading…</span>';

  if (isImage(name)) {
    // inline styles intentionally omitted — .preview-body img already covers max-width + border-radius
    elPreviewBody.innerHTML = `<img src="${storage.url(entry.path)}" alt="${name}" />`;
    return;
  }

  const ext = getExtension(name);

  if (isMarkdown(name)) {
    try {
      const content = await storage.read(entry.path, { as: 'text' }) as string;
      setState('previewContent', content);
      const htmlContent = marked.parse(content) as string;
      elPreviewBody.innerHTML = `<div class="md-preview">${htmlContent}</div>`;
    } catch {
      elPreviewBody.innerHTML = PREVIEW_UNAVAILABLE;
    }
    return;
  }

  if (isPreviewable(name)) {
    try {
      const content = await storage.read(entry.path, { as: 'text' }) as string;
      setState('previewContent', content);

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
    window.open(storage.url(entry.path), '_blank');
  });
}

export function closePreview() {
  setState('selectedFile', null);
  setState('previewContent', null);
  setState('showPreview', false);
}
