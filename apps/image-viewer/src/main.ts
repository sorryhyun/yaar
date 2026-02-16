const root = document.getElementById('app') ?? document.body;

type ImageItem = {
  id: number;
  name: string;
  source: string;
  path?: string;
};

type LayoutMode = 'single' | 'grid';

type YaarStorage = {
  list: (dirPath?: string) => Promise<Array<{ path: string; isDirectory: boolean }>>;
  url: (path: string) => string;
};

type AppApi = {
  register: (manifest: any) => void;
  sendInteraction: (payload: string | object) => void;
};

const yaar: any = (window as any).yaar ?? {};
const storage: YaarStorage | undefined = yaar.storage;
const appApi: AppApi | undefined = yaar.app;

let images: ImageItem[] = [];
let selectedIds = new Set<number>();
let nextId = 1;
let mode: LayoutMode = 'grid';
let columns = 3;

root.innerHTML = `
<style>
  * { box-sizing: border-box; font-family: Inter, system-ui, -apple-system, sans-serif; }
  body { margin: 0; background: #0b1020; color: #e2e8f0; }
  .app { height: 100vh; display: grid; grid-template-rows: auto 1fr auto; }
  .toolbar {
    display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
    padding: 10px; border-bottom: 1px solid #233150; background: #0f172a;
  }
  .toolbar button, .toolbar select, .toolbar input {
    border: 1px solid #334155; background: #111827; color: #e2e8f0;
    border-radius: 8px; padding: 6px 10px;
  }
  .toolbar button:hover { cursor: pointer; background: #1f2937; }
  .main { min-height: 0; display: grid; grid-template-columns: 260px 1fr; }
  .sidebar {
    border-right: 1px solid #233150; min-height: 0;
    display: grid; grid-template-rows: auto 1fr;
  }
  .side-head { padding: 8px 10px; font-size: 12px; color: #94a3b8; border-bottom: 1px solid #1e293b; }
  .thumbs { overflow: auto; padding: 8px; display: grid; gap: 8px; align-content: start; }
  .thumb {
    width: 100%; border: 1px solid #334155; border-radius: 8px;
    background: #111827; color: #cbd5e1; padding: 6px; text-align: left;
    font-size: 11px; cursor: pointer;
  }
  .thumb.active { border-color: #22d3ee; box-shadow: 0 0 0 1px #22d3ee inset; }
  .thumb img { width: 100%; height: 100px; object-fit: cover; border-radius: 6px; display: block; margin-bottom: 6px; }
  .viewer-wrap {
    min-height: 0;
    overflow: auto;
    padding: 10px;
    display: flex;
  }
  #viewer { width: 100%; min-height: 0; }
  .viewer-grid {
    display: grid; gap: 10px;
    grid-template-columns: repeat(var(--cols), minmax(180px, 1fr));
  }
  .viewer-single {
    height: 100%;
    min-height: 0;
    display: flex;
  }
  .viewer-single .panel {
    width: 100%;
    display: grid;
    grid-template-rows: auto 1fr;
  }
  .panel {
    border: 1px solid #334155; border-radius: 10px; background: #0f172a;
    overflow: hidden;
  }
  .panel-head {
    padding: 8px 10px; font-size: 12px; color: #cbd5e1;
    border-bottom: 1px solid #1e293b; background: #0b1220;
  }
  .panel img {
    width: 100%;
    height: min(65vh, 520px);
    object-fit: contain;
    background: #020617;
    display: block;
  }
  .viewer-single .panel img {
    height: 100%;
    max-height: none;
  }
  .empty {
    color: #94a3b8; border: 1px dashed #334155; border-radius: 10px;
    padding: 30px; text-align: center;
  }
  .status { padding: 8px 12px; border-top: 1px solid #233150; color: #94a3b8; font-size: 12px; }
</style>
<div class="app">
  <div class="toolbar">
    <input id="fileInput" type="file" accept="image/*" multiple />
    <button id="loadStorageBtn">Load storage images</button>
    <button id="gridBtn">Grid</button>
    <button id="singleBtn">Single</button>
    <label>Cols <input id="colsInput" type="number" min="1" max="8" value="3" style="width:64px" /></label>
    <button id="clearBtn">Clear</button>
  </div>
  <div class="main">
    <aside class="sidebar">
      <div class="side-head">Loaded Images</div>
      <div id="thumbs" class="thumbs"></div>
    </aside>
    <div class="viewer-wrap"><div id="viewer"></div></div>
  </div>
  <div id="status" class="status">Ready.</div>
</div>
`;

const fileInput = document.getElementById('fileInput') as HTMLInputElement;
const loadStorageBtn = document.getElementById('loadStorageBtn') as HTMLButtonElement;
const gridBtn = document.getElementById('gridBtn') as HTMLButtonElement;
const singleBtn = document.getElementById('singleBtn') as HTMLButtonElement;
const colsInput = document.getElementById('colsInput') as HTMLInputElement;
const clearBtn = document.getElementById('clearBtn') as HTMLButtonElement;
const thumbsEl = document.getElementById('thumbs') as HTMLDivElement;
const viewerEl = document.getElementById('viewer') as HTMLDivElement;
const statusEl = document.getElementById('status') as HTMLDivElement;

function setStatus(msg: string) {
  statusEl.textContent = msg;
}

function baseName(path: string) {
  return path.split('/').pop() || path;
}

function renderThumbs() {
  thumbsEl.innerHTML = '';
  if (!images.length) {
    thumbsEl.innerHTML = '<div class="empty">No images loaded.</div>';
    return;
  }
  for (const item of images) {
    const btn = document.createElement('button');
    const active = selectedIds.has(item.id) ? ' active' : '';
    btn.className = `thumb${active}`;
    btn.innerHTML = `<img src="${item.source}" alt="${item.name}"/><div>${item.name}</div>`;
    btn.onclick = () => {
      if (mode === 'single') {
        selectedIds = new Set([item.id]);
      } else {
        if (selectedIds.has(item.id)) selectedIds.delete(item.id);
        else selectedIds.add(item.id);
        if (!selectedIds.size) selectedIds.add(item.id);
      }
      renderAll();
      appApi?.sendInteraction({ event: 'select_images', ids: [...selectedIds] });
    };
    thumbsEl.appendChild(btn);
  }
}

function renderViewer() {
  viewerEl.innerHTML = '';
  if (!images.length) {
    viewerEl.innerHTML = '<div class="empty">Load files or send images via App Protocol.</div>';
    return;
  }

  let showItems = images;
  if (selectedIds.size) showItems = images.filter((x) => selectedIds.has(x.id));
  if (mode === 'single') showItems = showItems.length ? [showItems[0]] : [images[0]];

  const container = document.createElement('div');
  container.className = mode === 'single' ? 'viewer-single' : 'viewer-grid';
  if (mode === 'grid') {
    container.style.setProperty('--cols', String(Math.max(1, columns)));
  }

  for (const item of showItems) {
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `<div class="panel-head">${item.name}</div><img src="${item.source}" alt="${item.name}"/>`;
    container.appendChild(panel);
  }
  viewerEl.appendChild(container);
}

function renderAll() {
  renderThumbs();
  renderViewer();
  setStatus(`${images.length} image(s) loaded · mode=${mode}${mode === 'grid' ? ` · cols=${columns}` : ''}`);
}

function normalizeInputImage(input: { name?: string; path?: string; url?: string; dataUrl?: string }): ImageItem | null {
  const source = input.url || input.dataUrl;
  if (!source) return null;
  return {
    id: nextId++,
    name: input.name || (input.path ? baseName(input.path) : `Image ${nextId - 1}`),
    source,
    path: input.path,
  };
}

function setImages(items: ImageItem[], replace = true) {
  images = replace ? items : [...images, ...items];
  if (images.length) selectedIds = new Set([images[0].id]);
  else selectedIds = new Set();
  renderAll();
}

async function loadStoragePaths(paths: string[], replace = false) {
  if (!storage?.url) {
    setStatus('Storage API unavailable.');
    return;
  }
  const loaded = paths.map((p) => ({ id: nextId++, name: baseName(p), source: storage.url(p), path: p }));
  setImages(loaded, replace);
}

async function loadAllStorageImages() {
  if (!storage?.list || !storage?.url) {
    setStatus('Storage API unavailable.');
    return;
  }
  const entries = await storage.list('');
  const paths = entries
    .filter((e) => !e.isDirectory && /\.(png|jpe?g|gif|webp|bmp)$/i.test(e.path))
    .map((e) => e.path);
  await loadStoragePaths(paths, true);
  setStatus(`Loaded ${paths.length} image(s) from storage.`);
}

fileInput.addEventListener('change', async () => {
  const files = [...(fileInput.files || [])];
  if (!files.length) return;

  const toDataUrl = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

  const loaded: ImageItem[] = [];
  for (const file of files) {
    const dataUrl = await toDataUrl(file);
    loaded.push({ id: nextId++, name: file.name, source: dataUrl });
  }
  setImages(loaded, true);
  appApi?.sendInteraction({ event: 'loaded_local_files', count: loaded.length });
});

loadStorageBtn.onclick = () => loadAllStorageImages();
gridBtn.onclick = () => { mode = 'grid'; renderAll(); };
singleBtn.onclick = () => { mode = 'single'; renderAll(); };
colsInput.onchange = () => {
  columns = Math.max(1, Math.min(8, Number(colsInput.value) || 3));
  colsInput.value = String(columns);
  renderAll();
};
clearBtn.onclick = () => setImages([], true);

renderAll();

if (appApi) {
  appApi.register({
    appId: 'image-viewer',
    name: 'Image Viewer',
    state: {
      images: {
        description: 'List of loaded images',
        handler: () => images.map(({ id, name, path }) => ({ id, name, path: path || null })),
      },
      selectedIds: {
        description: 'Currently selected image IDs',
        handler: () => [...selectedIds],
      },
      layout: {
        description: 'Current layout mode and columns',
        handler: () => ({ mode, columns }),
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
          return { ok: true, count: images.length };
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
          mode = p.mode;
          if (typeof p.columns === 'number') {
            columns = Math.max(1, Math.min(8, Math.floor(p.columns)));
            colsInput.value = String(columns);
          }
          renderAll();
          return { ok: true, layout: { mode, columns } };
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
          selectedIds = new Set(p.ids.filter((id) => images.some((img) => img.id === id)));
          if (!selectedIds.size && images.length) selectedIds = new Set([images[0].id]);
          renderAll();
          return { ok: true, selectedIds: [...selectedIds] };
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
