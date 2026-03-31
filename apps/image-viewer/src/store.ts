import { createSignal } from '@bundled/solid-js';
import { storage, list } from '@bundled/yaar';
import type { ImageItem, LayoutMode, RawImageInput } from './types';
import {
  baseName,
  makeStatusText,
  clampColumns,
  IMAGE_EXT_REGEX,
  STORAGE_UNAVAILABLE,
  fileToDataUrl,
} from './helpers';

// --- Signals ---
// Internal setter is unexported; mutations go through the action functions below.
const [_images, _setImages] = createSignal<ImageItem[]>([]);
export const images = _images;

export const [selectedIds, setSelectedIds] = createSignal(new Set<number>());
export const [mode, setMode] = createSignal<LayoutMode>('grid');
export const [columns, setColumns] = createSignal(3);
export const [status, setStatus] = createSignal('Ready.');

let nextId = 1;

// --- Actions ---

/**
 * Convert a raw image input object into an ImageItem.
 * Returns null if neither `url` nor `dataUrl` is present.
 */
export function normalizeInputImage(input: RawImageInput): ImageItem | null {
  const source = input.url || input.dataUrl;
  if (!source) return null;
  const id = nextId++;
  return {
    id,
    name: input.name || (input.path ? baseName(input.path) : `Image ${id}`),
    source,
    path: input.path,
  };
}

/**
 * Set (or append) the image list, reset selection to the first item,
 * and update the status bar.
 */
export function setImages(items: ImageItem[], replace = true): void {
  const next = replace ? items : [...images(), ...items];
  _setImages(() => next);
  setSelectedIds(next.length ? new Set([next[0].id]) : new Set<number>());
  setStatus(makeStatusText(next.length, mode(), columns()));
}

/** Load images from YAAR storage paths */
export function loadStoragePaths(paths: string[], replace = false): void {
  if (!storage?.url) {
    setStatus(STORAGE_UNAVAILABLE);
    return;
  }
  const items = paths.map((p) => ({
    id: nextId++,
    name: baseName(p),
    source: storage!.url(p),
    path: p,
  }));
  setImages(items, replace);
}

/** Discover and load all image files from the app storage root */
export async function loadAllStorageImages(): Promise<void> {
  if (!storage?.url) {
    setStatus(STORAGE_UNAVAILABLE);
    return;
  }
  try {
    const entries = await list('yaar://apps/self/storage/') as Array<{ name: string; description?: string; path?: string; isDirectory?: boolean }>;
    const paths = entries
      .filter((e) => {
        const isDir = e.isDirectory ?? e.description === 'directory';
        const filePath = e.path ?? e.name;
        return !isDir && IMAGE_EXT_REGEX.test(filePath);
      })
      .map((e) => e.path ?? e.name);
    loadStoragePaths(paths, true);
    setStatus(`Loaded ${paths.length} image(s) from storage.`);
  } catch {
    setStatus(STORAGE_UNAVAILABLE);
  }
}

/** Read local File objects and load them as images */
export async function loadLocalFiles(files: File[]): Promise<void> {
  const items: ImageItem[] = [];
  for (const file of files) {
    items.push({ id: nextId++, name: file.name, source: await fileToDataUrl(file) });
  }
  setImages(items, true);
}

/**
 * Return the images that should currently be visible in the viewer,
 * respecting the active selection and layout mode.
 */
export function getShowItems(): ImageItem[] {
  const imgs = images();
  const sel = selectedIds();
  let shown = sel.size ? imgs.filter((x) => sel.has(x.id)) : imgs;
  if (mode() === 'single') shown = shown.length ? [shown[0]] : imgs.length ? [imgs[0]] : [];
  return shown;
}

/** Toggle or set selection for a thumbnail click */
export function selectImage(item: ImageItem): void {
  if (mode() === 'single') {
    setSelectedIds(new Set([item.id]));
    return;
  }
  const next = new Set(selectedIds());
  if (next.has(item.id)) next.delete(item.id);
  else next.add(item.id);
  // Always keep at least one image selected
  if (!next.size) next.add(item.id);
  setSelectedIds(next);
}
