import { ImageItem, LayoutMode } from './types';

type AppApi = {
  register: (manifest: any) => void;
};

type ReadableSignal<T> = () => T;
type WritableSignal<T> = ReadableSignal<T> & ((val: T) => void);

type ProtocolDeps = {
  images: WritableSignal<ImageItem[]>;
  selectedIds: WritableSignal<Set<number>>;
  mode: WritableSignal<LayoutMode>;
  columns: WritableSignal<number>;
  status: WritableSignal<string>;
  getColsInputEl: () => HTMLInputElement | undefined;
  setImages: (items: ImageItem[], replace?: boolean) => void;
  normalizeInputImage: (input: { name?: string; path?: string; url?: string; dataUrl?: string }) => ImageItem | null;
  loadStoragePaths: (paths: string[], replace?: boolean) => Promise<void>;
  loadAllStorageImages: () => Promise<void>;
};

export function setupProtocol(appApi: AppApi, deps: ProtocolDeps): void {
  const {
    images,
    selectedIds,
    mode,
    columns,
    status,
    getColsInputEl,
    setImages,
    normalizeInputImage,
    loadStoragePaths,
    loadAllStorageImages,
  } = deps;

  appApi.register({
    appId: 'image-viewer',
    name: 'Image Viewer',
    state: {
      images: {
        description: 'List of loaded images',
        handler: () => images().map(({ id, name, path }) => ({ id, name, path: path || null })),
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
        params: {
          type: 'object',
          properties: {
            images: {
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
            },
          },
          required: ['images'],
        },
        handler: (p: { images: Array<{ name?: string; path?: string; url?: string; dataUrl?: string }> }) => {
          const normalized = p.images.map(normalizeInputImage).filter(Boolean) as ImageItem[];
          setImages(normalized, true);
          return { ok: true, count: normalized.length };
        },
      },
      addImages: {
        description: 'Append multiple images in one call.',
        params: {
          type: 'object',
          properties: {
            images: {
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
            },
          },
          required: ['images'],
        },
        handler: (p: { images: Array<{ name?: string; path?: string; url?: string; dataUrl?: string }> }) => {
          const normalized = p.images.map(normalizeInputImage).filter(Boolean) as ImageItem[];
          setImages(normalized, false);
          return { ok: true, count: normalized.length };
        },
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
        handler: async (p: { paths: string[]; replace?: boolean }) => {
          await loadStoragePaths(p.paths, p.replace ?? false);
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
          mode(p.mode);
          if (typeof p.columns === 'number') {
            const c = Math.max(1, Math.min(8, Math.floor(p.columns)));
            columns(c);
            const colsInputEl = getColsInputEl();
            if (colsInputEl) colsInputEl.value = String(c);
          }
          status(`${images().length} image(s) loaded · mode=${mode()}${mode() === 'grid' ? ` · cols=${columns()}` : ''}`);
          return { ok: true, layout: { mode: mode(), columns: columns() } };
        },
      },
      selectImages: {
        description: 'Select images by IDs.',
        params: {
          type: 'object',
          properties: {
            ids: { type: 'array', items: { type: 'number' } },
          },
          required: ['ids'],
        },
        handler: (p: { ids: number[] }) => {
          const imgs = images();
          const valid = new Set(p.ids.filter((id) => imgs.some((img) => img.id === id)));
          if (!valid.size && imgs.length) valid.add(imgs[0].id);
          selectedIds(valid);
          return { ok: true, selectedIds: [...selectedIds()] };
        },
      },
      clear: {
        description: 'Clear all loaded images.',
        params: { type: 'object', properties: {} },
        handler: () => {
          setImages([], true);
          return { ok: true };
        },
      },
    },
  });
}
