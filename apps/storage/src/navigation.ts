export {};
import DOMPurify from '@bundled/dompurify';
import { marked } from '@bundled/marked';
import Prism from '@bundled/prismjs';
import { storage } from '@bundled/yaar';
import { setState, elPreviewBody } from './state';
import { basename, formatSize, isImage, isMarkdown, isPdf, isPreviewable, getFileIcon, getExtension } from './helpers';
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
  // The open preview persists across directory navigation — moving between
  // folders keeps the current content view in place. The preview is only
  // replaced when the user actually selects a different file (selectFile) or
  // explicitly closes it (closePreview). The selected-row highlight simply
  // won't show while the selected file lives outside the current directory.
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
  // The preview renders behind the overlay; the nav panel stays until the cursor
  // leaves it (onMouseLeave → scheduleNavClose), so selecting a file no longer
  // dismisses the panel on its own.

  elPreviewBody.innerHTML = '<span class="preview-loading">Loading…</span>';

  if (isImage(name)) {
    // Built via DOM construction rather than string interpolation: `name` is an
    // attacker-controlled filename, and a `"` in it would break out of the alt
    // attribute. Property assignment has no attribute-injection surface at all.
    // inline styles intentionally omitted — .preview-body img already covers max-width + border-radius
    const img = document.createElement('img');
    img.src = storage.url(entry.path);
    img.alt = name;
    elPreviewBody.replaceChildren(img);
    return;
  }

  if (isPdf(name)) {
    // The browser renders PDFs natively; point an iframe at the file's storage
    // URL. Built via DOM construction rather than string interpolation because
    // `name`/path are attacker-controlled filenames — property assignment has no
    // attribute-injection surface. The iframe is same-origin to /api/storage and
    // carries no app scripting, so it's a plain document viewer.
    const frame = document.createElement('iframe');
    frame.className = 'pdf-frame';
    frame.src = storage.url(entry.path);
    frame.title = name;
    elPreviewBody.replaceChildren(frame);
    return;
  }

  const ext = getExtension(name);

  if (isMarkdown(name)) {
    try {
      const content = await storage.read(entry.path, { as: 'text' }) as string;
      setState('previewContent', content);
      // Stored file content is untrusted and marked does NOT escape raw HTML,
      // so the parsed fragment must be sanitized before it reaches the DOM.
      // Order: parse -> sanitize whole fragment -> wrap -> insert.
      // Deviation from the bare frontend MarkdownRenderer baseline: DOMPurify's
      // default allowlist permits <form> and its controls, so a stored .md file
      // could render a credential-phishing form that posts to an attacker origin
      // from inside this app. Markdown never produces form elements, so denying
      // them costs no fidelity. Everything else stays at DOMPurify defaults.
      // Note: DOMPurify lifts a forbidden tag's children without re-scanning
      // them, so a stray <input> can outlive its <form>. That leftover is inert
      // (no form to submit to, and event attributes are stripped regardless).
      const htmlContent = DOMPurify.sanitize(marked.parse(content) as string, {
        FORBID_TAGS: ['form', 'input', 'button', 'select', 'textarea', 'option'],
      });
      const wrapper = document.createElement('div');
      wrapper.className = 'md-preview';
      wrapper.innerHTML = htmlContent;
      elPreviewBody.replaceChildren(wrapper);
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

      // Not sanitized, deliberately: Prism.highlight HTML-escapes its input
      // before wrapping it in <span> tokens, and `lang` is a value from the
      // fixed EXT_LANG map (never raw user input), so neither interpolation
      // can inject markup. Do not copy this pattern to sinks fed by raw text.
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
