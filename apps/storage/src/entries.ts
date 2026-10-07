export {};
import { Show, createSignal } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { storage, windows, showConfirm } from '@bundled/yaar';
import type { StorageEntry } from './types';
import { state, setState } from './state';
import {
  basename,
  formatModified,
  formatSize,
  formatTimestamp,
  getFileIcon,
  isImage,
} from './helpers';
import { handleDragStart, handleDragEnd, requestOpenByAgent } from './drag';
import { navigate, selectFile } from './navigation';
import { closeNav, navDrawer } from './navOverlay';

// One entry, two renderings: the list row and the grid tile share every
// interaction, so a behaviour added here reaches both views.

// "5 min ago" goes stale while the listing sits open; a minute tick keeps every
// relative label honest without re-fetching the directory.
const [now, setNow] = createSignal(Date.now());
setInterval(() => setNow(Date.now()), 60_000);

/**
 * Opening a file closes the drawer, which on a narrow window covers the whole preview.
 * The wide-window overlay is left to its hover fold: it covers only the left edge, a
 * pinned one is an explicit "keep this open", and folding it on the first click would
 * pull the row out from under the second click of a double-click (open by agent).
 * Only user gestures close it; an agent's `select-file` lands in one arbitrary copy,
 * and the panel is per-viewport chrome (see `set-layout`).
 */
function dismissDrawer() {
  if (navDrawer()) closeNav();
}

function openFile(entry: StorageEntry) {
  dismissDrawer();
  void selectFile(entry);
}

function activate(e: MouseEvent, entry: StorageEntry) {
  if ((e.target as HTMLElement).closest('.file-actions')) return;
  if (entry.isDirectory) navigate(entry.path);
  else openFile(entry);
}

function openByAgent(e: MouseEvent, entry: StorageEntry) {
  if ((e.target as HTMLElement).closest('.file-actions')) return;
  if (!entry.isDirectory) requestOpenByAgent(entry);
}

async function deleteEntry(e: MouseEvent, entry: StorageEntry) {
  e.stopPropagation();
  const name = basename(entry.path);
  if (!(await showConfirm(`Delete "${name}"?`, { danger: true, okLabel: 'Delete' }))) return;
  try {
    await storage.remove(entry.path);
    navigate(state.currentPath);
  } catch {
    setState('statusText', `Failed to delete ${name}`);
  }
}

function EntryActions(entry: StorageEntry) {
  const name = basename(entry.path);
  return html`
    <span class="file-actions">
      <${Show} when=${() => !entry.isDirectory}>
        <button title="Open in a window" onClick=${(e: MouseEvent) => {
          e.stopPropagation();
          dismissDrawer();
          windows.openUrl(storage.url(entry.path), { title: name });
        }}>⇗</button>
      <//>
      <button class="danger" title="Delete" onClick=${(e: MouseEvent) => deleteEntry(e, entry)}>🗑</button>
    </span>
  `;
}

function entryClass(base: string, entry: StorageEntry) {
  return () => `${base}${state.selectedFile === entry.path ? ' selected' : ''}`;
}

export function FileRow(entry: StorageEntry) {
  const name = basename(entry.path);
  return html`
    <div
      class=${entryClass('file-row', entry)}
      draggable="true"
      onClick=${(e: MouseEvent) => activate(e, entry)}
      onDblclick=${(e: MouseEvent) => openByAgent(e, entry)}
      onDragstart=${(e: DragEvent) => handleDragStart(e, entry)}
      onDragend=${(e: DragEvent) => handleDragEnd(e)}
    >
      <span class="file-icon">${getFileIcon(name, entry.isDirectory)}</span>
      <span class=${`file-name${entry.isDirectory ? ' dir' : ''}`}>${name}</span>
      <span class="file-date" title=${formatTimestamp(entry.modifiedAt)}>${() =>
        formatModified(entry.modifiedAt, now())}</span>
      <span class="file-size">${entry.isDirectory ? '' : formatSize(entry.size)}</span>
      ${EntryActions(entry)}
    </div>
  `;
}

export function FileTile(entry: StorageEntry) {
  const name = basename(entry.path);
  const icon = getFileIcon(name, entry.isDirectory);
  // A thumbnail that fails to load (corrupt file, unsupported format) falls
  // back to the type icon instead of the browser's broken-image glyph.
  const [thumbFailed, setThumbFailed] = createSignal(false);
  const wantsThumb = !entry.isDirectory && isImage(name);
  const modified = formatTimestamp(entry.modifiedAt);
  const tooltip = [name, entry.isDirectory ? '' : formatSize(entry.size), modified]
    .filter(Boolean)
    .join('\n');
  return html`
    <div
      class=${entryClass('file-tile', entry)}
      title=${tooltip}
      draggable="true"
      onClick=${(e: MouseEvent) => activate(e, entry)}
      onDblclick=${(e: MouseEvent) => openByAgent(e, entry)}
      onDragstart=${(e: DragEvent) => handleDragStart(e, entry)}
      onDragend=${(e: DragEvent) => handleDragEnd(e)}
    >
      <div class="file-tile-visual">
        <${Show}
          when=${() => wantsThumb && !thumbFailed()}
          fallback=${html`<span class="file-tile-icon">${icon}</span>`}
        >
          <img
            class="file-tile-thumb"
            src=${storage.url(entry.path)}
            alt=""
            loading="lazy"
            decoding="async"
            draggable="false"
            onError=${() => setThumbFailed(true)}
          />
        <//>
      </div>
      <span class=${`file-tile-name${entry.isDirectory ? ' dir' : ''}`}>${name}</span>
      <span class="file-tile-meta">${() => formatModified(entry.modifiedAt, now())}</span>
      ${EntryActions(entry)}
    </div>
  `;
}
