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
  let currentStorageFiles: string[] = [];

  const setSidebarMessage = (message: string): void => {
    ui.fileListStatus.textContent = message;
  };

  const clearSidebarList = (): void => {
    ui.fileList.textContent = '';
  };

  const applyFilter = (): void => {
    const query = ui.fileSearch.value.trim().toLowerCase();
    const filtered = query
      ? currentStorageFiles.filter((p) => p.toLowerCase().includes(query))
      : currentStorageFiles;

    clearSidebarList();

    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'storage-empty';
      empty.textContent = query ? `No files match "${query}".` : 'No video files found in this path.';
      ui.fileList.appendChild(empty);
      return;
    }

    for (const path of filtered) {
      const segments = path.split('/');
      const filename = segments.pop() ?? path;
      const dir = segments.length ? segments.join('/') + '/' : '';

      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'storage-item';
      item.title = path;

      const nameEl = document.createElement('div');
      nameEl.className = 'file-name';
      nameEl.textContent = '▶  ' + filename;
      item.appendChild(nameEl);

      if (dir) {
        const dirEl = document.createElement('div');
        dirEl.className = 'file-dir';
        dirEl.textContent = dir;
        item.appendChild(dirEl);
      }

      item.addEventListener('click', () => {
        const loaded = opts.onFileSelect(toStorageUrl(path), path);
        if (loaded) {
          setSidebarMessage(`Loaded: ${filename}`);
          ui.fileList.querySelectorAll<HTMLElement>('.storage-item').forEach((el) =>
            el.classList.remove('active'),
          );
          item.classList.add('active');
        }
      });

      ui.fileList.appendChild(item);
    }
  };

  const refresh = async (): Promise<void> => {
    const storageApi = getStorageApi();
    if (!storageApi) {
      clearSidebarList();
      setSidebarMessage('Storage API unavailable in this environment.');
      return;
    }

    const basePath = normalizeStoragePath(ui.storagePathInput.value) || DEFAULT_STORAGE_LIST_PATH;
    ui.storagePathInput.value = basePath;
    opts.persistPrefs({ lastStorageListPath: basePath });

    ui.refreshFilesButton.disabled = true;
    setSidebarMessage(`Scanning ${basePath}...`);

    try {
      const storageVideos = await collectStorageVideoPaths(storageApi, basePath);
      storageVideos.sort((a, b) => a.localeCompare(b));
      currentStorageFiles = [...storageVideos];
      applyFilter();
      setSidebarMessage(`Found ${storageVideos.length} video file${storageVideos.length === 1 ? '' : 's'} in ${basePath}.`);
    } catch {
      clearSidebarList();
      setSidebarMessage(`Unable to list files in ${basePath}.`);
    } finally {
      ui.refreshFilesButton.disabled = false;
    }
  };

  return { refresh, applyFilter };
}
