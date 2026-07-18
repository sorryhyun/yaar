import { For, Show, onCleanup, onMount } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import {
  libraryOpen,
  openStoragePath,
  refreshStorageFiles,
  setLibraryOpen,
  storageFiles,
  type StorageFile,
} from '../store';
import { removeFile } from './actions';

// Library thumbnails deliberately omit loading="lazy": inside the app iframe
// the intersection check never fires, so lazy images stay blank forever.
// Note also that HTML comments inside an `html` template misalign the
// expression indices - keep notes like this one outside the template.

/** Opens the modal and refreshes the listing, so it never shows a stale grid. */
export function openLibrary(): void {
  setLibraryOpen(true);
  void refreshStorageFiles();
}

export function closeLibrary(): void {
  setLibraryOpen(false);
}

/**
 * The library grid, as a centred modal. The overlay is position:fixed against
 * the viewport rather than absolutely positioned against the toolbar, so no
 * ancestor width, overflow or stacking context can shift or clip it.
 */
export function LibraryModal() {
  const onKey = (e: KeyboardEvent) => {
    if (libraryOpen() && e.key === 'Escape') {
      e.stopPropagation();
      closeLibrary();
    }
  };

  onMount(() => document.addEventListener('keydown', onKey, true));
  onCleanup(() => document.removeEventListener('keydown', onKey, true));

  const pick = (path: string) => {
    closeLibrary();
    void openStoragePath(path);
  };

  return html`
    <${Show} when=${libraryOpen}>
      <div
        class="lib-overlay"
        role="presentation"
        onClick=${(e: MouseEvent) => {
          if (e.target === e.currentTarget) closeLibrary();
        }}
      >
        <div class="lib-modal" role="dialog" aria-modal="true" aria-label="Library">
          <div class="lib-modal-head">
            <span class="lib-modal-title">Library</span>
            <div class="lib-modal-actions">
              <button
                class="y-btn y-btn-sm y-btn-ghost"
                onClick=${() => void refreshStorageFiles()}
              >
                Refresh
              </button>
              <button
                class="y-btn y-btn-sm y-btn-ghost lib-close"
                title="Close"
                aria-label="Close"
                onClick=${closeLibrary}
              >
                ×
              </button>
            </div>
          </div>

          <div class="lib-modal-body y-scroll">
            <${Show}
              when=${() => storageFiles().length > 0}
              fallback=${() =>
                html`<div class="lib-empty">
                  <div class="lib-empty-icon">🖼</div>
                  <div class="y-text-sm y-text-muted">No saved images yet.</div>
                  <div class="y-text-xs y-text-dim">
                    Edit an image and press “Save” to add it here.
                  </div>
                </div>`}
            >
              <div class="lib-grid">
                <${For} each=${storageFiles}>
                  ${(file: StorageFile) => html`
                    <div class="lib-item">
                      <button class="lib-thumb" title=${file.name} onClick=${() => pick(file.path)}>
                        <img src=${file.url} alt=${file.name} />
                        <span class="y-truncate lib-name">${file.name}</span>
                      </button>
                      <button
                        class="lib-del"
                        title="Delete"
                        aria-label=${`Delete ${file.name}`}
                        onClick=${() => removeFile(file)}
                      >
                        ×
                      </button>
                    </div>
                  `}
                <//>
              </div>
            <//>
          </div>
        </div>
      </div>
    <//>
  `;
}
