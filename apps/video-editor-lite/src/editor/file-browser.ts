import { html, signal, mount } from '@bundled/yaar';
import type { EditorUI } from './ui';
import type { EditorPrefs } from './prefs';
import {
  getStorageApi,
  normalizeStoragePath,
  toStorageUrl,
  collectStorageVideoPaths,
  DEFAULT_STORAGE_LIST_PATH,
} from './storage-utils';

export interface FileBrowser {
  refresh(): Promise<void>;
  applyFilter(): void;
}

export function createFileBrowser(
  ui: EditorUI,
  opts: {
    persistPrefs(patch: Partial<EditorPrefs>): void;
    onFileSelect(storageUrl: string, storagePath: string): boolean;
  },
): FileBrowser {
  const allFiles = signal<string[]>([]);
  const filterQuery = signal('');
  let activeItem: HTMLElement | null = null;

  // Mount the reactive file list into the fileList container
  mount(html`
    <div>
      ${() => {
        const query = filterQuery().toLowerCase();
        const files = allFiles();
        const filtered = query ? files.filter((p) => p.toLowerCase().includes(query)) : files;

        if (!filtered.length) {
          return html`
            <div class="storage-empty">
              ${query ? `No files match "${query}".` : 'No video files found in this path.'}
            </div>
          `;
        }

        return filtered.map((path) => {
          const segments = path.split('/');
          const filename = segments.pop() ?? path;
          const dir = segments.length ? segments.join('/') + '/' : '';

          return html`
            <button type="button" class="storage-item" title=${path}
                    onClick=${(e: MouseEvent) => {
                      const loaded = opts.onFileSelect(toStorageUrl(path), path);
                      if (loaded) {
                        ui.fileListStatus.textContent = `Loaded: ${filename}`;
                        if (activeItem) activeItem.classList.remove('active');
                        activeItem = e.currentTarget as HTMLElement;
                        activeItem.classList.add('active');
                      }
                    }}>
              <div class="file-name">▶  ${filename}</div>
              ${dir ? html`<div class="file-dir">${dir}</div>` : null}
            </button>
          `;
        });
      }}
    </div>
  `, ui.fileList);

  const applyFilter = (): void => {
    filterQuery(ui.fileSearch.value.trim());
  };

  const refresh = async (): Promise<void> => {
    const storageApi = getStorageApi();
    if (!storageApi) {
      allFiles([]);
      ui.fileListStatus.textContent = 'Storage API unavailable in this environment.';
      return;
    }

    const basePath = normalizeStoragePath(ui.storagePathInput.value) || DEFAULT_STORAGE_LIST_PATH;
    ui.storagePathInput.value = basePath;
    opts.persistPrefs({ lastStorageListPath: basePath });

    ui.refreshFilesButton.disabled = true;
    ui.fileListStatus.textContent = `Scanning ${basePath}...`;

    try {
      const storageVideos = await collectStorageVideoPaths(storageApi, basePath);
      storageVideos.sort((a, b) => a.localeCompare(b));
      allFiles([...storageVideos]);
      filterQuery(ui.fileSearch.value.trim());
      ui.fileListStatus.textContent = `Found ${storageVideos.length} video file${storageVideos.length === 1 ? '' : 's'} in ${basePath}.`;
    } catch {
      allFiles([]);
      ui.fileListStatus.textContent = `Unable to list files in ${basePath}.`;
    } finally {
      ui.refreshFilesButton.disabled = false;
    }
  };

  return { refresh, applyFilter };
}
