export {};
import { storage, currentPath, entries, selectedFile, previewContent, showPreview, statusText, previewTitleText, previewMetaText, elPreviewBody } from './state';
import { basename, formatSize, isImage, isPreviewable, getFileIcon } from './helpers';
import { refreshMountAliases } from './mount-dialog';

export async function navigate(path: string) {
  currentPath(path);
  selectedFile(null);
  previewContent(null);
  showPreview(false);
  statusText('Loading...');
  try {
    await refreshMountAliases();
    const fetched = await storage.list(path);
    fetched.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return basename(a.path).localeCompare(basename(b.path));
    });
    entries(fetched);
    const dirs = fetched.filter((e) => e.isDirectory).length;
    const files = fetched.length - dirs;
    statusText(`${files} file${files !== 1 ? 's' : ''}, ${dirs} folder${dirs !== 1 ? 's' : ''}`);
  } catch {
    entries([]);
    statusText('Error loading directory');
  }
}

export async function selectFile(entry: import('./types').StorageEntry) {
  const name = basename(entry.path);
  selectedFile(entry.path);
  previewContent(null);
  previewTitleText(name);
  previewMetaText(formatSize(entry.size));
  showPreview(true);

  elPreviewBody.innerHTML = '<span style="color:var(--yaar-text-muted)">Loading...</span>';

  if (isImage(name)) {
    elPreviewBody.innerHTML = `<img src="${storage.url(entry.path)}" alt="${name}" />`;
    return;
  }

  if (isPreviewable(name)) {
    try {
      const content = await storage.read(entry.path, { as: 'text' });
      previewContent(content);
      const escaped = content
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      elPreviewBody.innerHTML = `<pre>${escaped}</pre>`;
    } catch {
      elPreviewBody.innerHTML = '<span style="color:var(--yaar-text-muted)">Unable to preview</span>';
    }
    return;
  }

  elPreviewBody.innerHTML = `
    <div style="text-align:center;padding:20px">
      <div style="font-size:32px;margin-bottom:8px">${getFileIcon(name, false)}</div>
      <div style="color:var(--yaar-text-muted);margin-bottom:12px">No preview available</div>
      <button class="toolbar-btn" id="open-external">Open in browser</button>
    </div>
  `;
  document.getElementById('open-external')?.addEventListener('click', () => {
    window.open(storage.url(entry.path), '_blank');
  });
}

export function closePreview() {
  selectedFile(null);
  previewContent(null);
  showPreview(false);
}
