import type { ImageItem, LayoutMode, RawImageInput } from './types';
import {
  images, selectedIds, setSelectedIds,
  mode, setMode, columns, setColumns, setStatus,
  setImages, normalizeInputImage, loadStoragePaths, loadAllStorageImages,
} from './store';
import { makeStatusText, clampColumns } from './helpers';

type AppApi = {
  register: (manifest: unknown) => void;
};

/** Shared JSON Schema for an array of raw image input objects */
const IMAGE_ITEMS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      path: { type: 'string' },
      url: { type: 'string' },
      dataUrl: { type: 'string' },
    },
  },
};

/** Normalize, load, and return a result for a batch of raw image inputs */
function processImages(inputs: RawImageInput[], replace: boolean) {
  const items = inputs.map(normalizeInputImage).filter(Boolean) as ImageItem[];
  setImages(items, replace);
  return { ok: true, count: items.length };
}

export function setupProtocol(appApi: AppApi): void {
  appApi.register({
    appId: 'image-viewer',
    name: 'Image Viewer',
    state: {
      images: {
        description: 'List of loaded images',
        handler: () => images().map(({ id, name, path }) => ({ id, name, path: path ?? null })),
      },
      selectedIds: {
        description: 'Currently selected image IDs',
        handler: () => [...selectedIds()],
      },
      layout: {
        description: 'Current layout mode and columns',
        handler: () => ({ mode: mode(), columns: columns() }),
      },
    },
    commands: {
      setImages: {
        description: 'Replace images with a new set. Accepts URL/dataUrl/path+url.',
        params: { type: 'object', properties: { images: IMAGE_ITEMS_SCHEMA }, required: ['images'] },
        handler: (p: { images: RawImageInput[] }) => processImages(p.images, true),
      },
      addImages: {
        description: 'Append images to the current set.',
        params: { type: 'object', properties: { images: IMAGE_ITEMS_SCHEMA }, required: ['images'] },
        handler: (p: { images: RawImageInput[] }) => processImages(p.images, false),
      },
      openStoragePaths: {
        description: 'Load multiple storage file paths at once.',
        params: {
          type: 'object',
          properties: {
            paths: { type: 'array', items: { type: 'string' } },
            replace: { type: 'boolean' },
          },
          required: ['paths'],
        },
        handler: (p: { paths: string[]; replace?: boolean }) => {
          loadStoragePaths(p.paths, p.replace ?? false);
          return { ok: true, count: p.paths.length };
        },
      },
      loadStorageAll: {
        description: 'Load all image files from storage root.',
        params: { type: 'object', properties: {} },
        handler: async () => {
          await loadAllStorageImages();
          return { ok: true, count: images().length };
        },
      },
      setLayout: {
        description: 'Set viewer layout mode and columns.',
        params: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['single', 'grid'] },
            columns: { type: 'number' },
          },
          required: ['mode'],
        },
        handler: (p: { mode: LayoutMode; columns?: number }) => {
          setMode(p.mode);
          if (typeof p.columns === 'number') setColumns(clampColumns(p.columns));
          setStatus(makeStatusText(images().length, mode(), columns()));
          return { ok: true, layout: { mode: mode(), columns: columns() } };
        },
      },
      selectImages: {
        description: 'Select images by IDs.',
        params: {
          type: 'object',
          properties: { ids: { type: 'array', items: { type: 'number' } } },
          required: ['ids'],
        },
        handler: (p: { ids: number[] }) => {
          const imgs = images();
          const valid = new Set(p.ids.filter((id) => imgs.some((img) => img.id === id)));
          if (!valid.size && imgs.length) valid.add(imgs[0].id);
          setSelectedIds(valid);
          return { ok: true, selectedIds: [...selectedIds()] };
        },
      },
      clear: {
        description: 'Clear all loaded images.',
        params: { type: 'object', properties: {} },
        handler: () => { setImages([], true); return { ok: true }; },
      },
    },
  });
}
