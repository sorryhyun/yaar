export {};
import { renderMarkdown } from '@bundled/marked';
import Prism from '@bundled/prismjs';
import { storage, windows, createSharedSignal } from '@bundled/yaar';
import { state, setState, elPreviewBody } from './state';
import {
  basename,
  formatSize,
  isImage,
  isMarkdown,
  isPdf,
  isPreviewable,
  getFileIcon,
  getExtension,
} from './helpers';
import { refreshMountAliases } from './mount-dialog';
import type { StorageEntry } from './types';

const EXT_LANG: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'tsx',
  jsx: 'jsx',
  py: 'python',
  css: 'css',
  scss: 'scss',
  html: 'html',
  xml: 'xml',
  svg: 'xml',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  sql: 'sql',
  toml: 'toml',
  rs: 'rust',
  go: 'go',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
};

const PREVIEW_UNAVAILABLE = '<span class="preview-unavailable">Unable to preview</span>';

/**
 * Directory + selection are shared across copies of this window: `navigate` and
 * `select-file` are agent commands, which land in whichever copy the server picked
 * to answer, and the companion tab is not necessarily the one on screen. Only the
 * path travels (not the listing or the preview bytes) — both are cheap to re-fetch,
 * and `storage.list`/`storage.read` are already on the hot path of every navigation.
 *
 * A copy that mounts late starts from these too (see `initFromShared`), instead of
 * always resetting to the root the way a single-copy app would.
 */
const [, setSharedPath, sharedPathReady] = createSharedSignal<string>('current-path', '', {
  onRemote: (path) => void loadDirectory(path),
});
const [, setSharedSelected, sharedSelectedReady] = createSharedSignal<string | null>(
  'selected-file',
  null,
  { onRemote: (path) => void applyRemoteSelection(path) },
);

async function loadDirectory(path: string) {
  setState('currentPath', path);
  // The open preview persists across directory navigation; only selectFile or
  // closePreview replace it. The selected-row highlight is absent while the
  // selected file lives outside the current directory.
  setState('statusText', 'Loading...');
  try {
    await refreshMountAliases();
    const fetched = (await storage.list(path)) as unknown as StorageEntry[];
    fetched.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return basename(a.path).localeCompare(basename(b.path));
    });
    setState('entries', fetched);
    const dirs = fetched.filter((e) => e.isDirectory).length;
    const files = fetched.length - dirs;
    setState(
      'statusText',
      `${files} file${files !== 1 ? 's' : ''}, ${dirs} folder${dirs !== 1 ? 's' : ''}`,
    );
  } catch {
    setState('entries', []);
    setState('statusText', 'Error loading directory');
  }
}

export async function navigate(path: string) {
  setSharedPath(path);
  await loadDirectory(path);
}

/**
 * Start this copy from wherever the window's shared state already is, rather than
 * always resetting to the root — a copy mounting after the agent has navigated
 * elsewhere (the companion tab, or a phone reconnecting) should show the same
 * thing the driven copy does. Never writes the shared signals itself: a value
 * already there came from another copy's `navigate`/`selectFile`, and re-sending
 * it would just be an echo.
 */
export async function initFromShared(): Promise<void> {
  const path = await sharedPathReady;
  await loadDirectory(path);
  const selected = await sharedSelectedReady;
  if (selected !== null) await applyRemoteSelection(selected);
}

async function applySelection(entry: StorageEntry) {
  const name = basename(entry.path);
  setState('selectedFile', entry.path);
  setState('previewContent', null);
  setState('previewTitleText', name);
  setState('previewMetaText', formatSize(entry.size));
  setState('showPreview', true);
  // The preview renders behind the overlay; the nav panel stays until the cursor
  // leaves it (onMouseLeave → scheduleNavClose), not on file selection.

  elPreviewBody.innerHTML = '<span class="preview-loading">Loading…</span>';

  if (isImage(name)) {
    // DOM construction, not string interpolation: `name` is an attacker-controlled
    // filename, and a `"` in it would break out of the alt attribute.
    // Sizing comes from `.preview-body img`.
    const img = document.createElement('img');
    img.src = storage.url(entry.path);
    img.alt = name;
    elPreviewBody.replaceChildren(img);
    return;
  }

  if (isPdf(name)) {
    // The browser renders PDFs natively in an iframe on the file's storage URL
    // (same-origin to /api/storage, no app scripting). DOM construction, not string
    // interpolation: `name`/path are attacker-controlled filenames.
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
      const content = (await storage.read(entry.path, { as: 'text' })) as string;
      setState('previewContent', content);
      // Stored file content is untrusted and marked does NOT escape raw HTML.
      // renderMarkdown parses, sanitizes the whole fragment, and sends links
      // outside the frame before any of it reaches the DOM.
      const htmlContent = renderMarkdown(content);
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
      const content = (await storage.read(entry.path, { as: 'text' })) as string;
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
      <button class="y-btn y-btn-sm" id="open-external">Open in a window ↗</button>
    </div>
  `;
  document.getElementById('open-external')?.addEventListener('click', () => {
    windows.openUrl(storage.url(entry.path), { title: name });
  });
}

export async function selectFile(entry: StorageEntry) {
  setSharedSelected(entry.path);
  await applySelection(entry);
}

/**
 * The other copy only sent a path, not the entry `selectFile` normally gets from a
 * directory listing — look it up in this copy's own (by-then-reloaded) entries, and
 * fall back to a bare file entry when it isn't there yet (e.g. this notification beat
 * the directory one). The fallback just means `formatSize` has nothing to show; the
 * actual preview fetch below is keyed on the path alone.
 */
async function applyRemoteSelection(path: string | null) {
  if (path === null) {
    applyClosePreview();
    return;
  }
  const entry = state.entries.find((e) => e.path === path) ?? { path, isDirectory: false };
  await applySelection(entry);
}

function applyClosePreview() {
  setState('selectedFile', null);
  setState('previewContent', null);
  setState('showPreview', false);
}

export function closePreview() {
  setSharedSelected(null);
  applyClosePreview();
}
