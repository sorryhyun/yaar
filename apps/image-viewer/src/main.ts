export {};
import { createSignal, Show, For } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import './styles.css';
import { ImageItem, LayoutMode } from './types';
import { setupProtocol } from './protocol';

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

// signals
const [images, setImages_] = createSignal<ImageItem[]>([]);
const [selectedIds, setSelectedIds] = createSignal(new Set<number>());
const [mode, setMode] = createSignal<LayoutMode>('grid');
const [columns, setColumns] = createSignal(3);
const [status, setStatus] = createSignal('Ready.');
let nextId = 1;

let fileInputEl!: HTMLInputElement;
let colsInputEl!: HTMLInputElement;

// helpers
function baseName(path: string) {
  return path.split('/').pop() || path;
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
  const next = replace ? items : [...images(), ...items];
  setImages_(() => next);
  if (next.length) setSelectedIds(new Set([next[0].id]));
  else setSelectedIds(new Set<number>());
  setStatus(`${next.length} image(s) loaded · mode=${mode()}${mode() === 'grid' ? ` · cols=${columns()}` : ''}`);
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

function getShowItems(): ImageItem[] {
  const imgs = images();
  const sel = selectedIds();
  let showItems = imgs;
  if (sel.size) showItems = imgs.filter((x) => sel.has(x.id));
  if (mode() === 'single') showItems = showItems.length ? [showItems[0]] : imgs.length ? [imgs[0]] : [];
  return showItems;
}

function selectImage(item: ImageItem) {
  const sel = selectedIds();
  if (mode() === 'single') {
    setSelectedIds(new Set([item.id]));
  } else {
    const next = new Set(sel);
    if (next.has(item.id)) next.delete(item.id);
    else next.add(item.id);
    if (!next.size) next.add(item.id);
    setSelectedIds(next);
  }
}

async function handleFileChange() {
  const files = [...(fileInputEl.files || [])];
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
}

render(() => html`
  <div class="app y-app">
    <div class="toolbar y-flex y-gap-2 y-p-2 y-surface y-border-b">
      <input
        ref=${(el: HTMLInputElement) => { fileInputEl = el; }}
        type="file"
        accept="image/*"
        multiple
        onchange=${() => handleFileChange()}
      />
      <button class="y-btn y-btn-sm" onClick=${() => loadAllStorageImages()}>Load storage images</button>
      <button class="y-btn y-btn-sm" onClick=${() => { setMode('grid'); setStatus(`${images().length} image(s) loaded · mode=grid · cols=${columns()}`); }}>Grid</button>
      <button class="y-btn y-btn-sm" onClick=${() => { setMode('single'); setStatus(`${images().length} image(s) loaded · mode=single`); }}>Single</button>
      <label class="y-text-sm">Cols <input
        ref=${(el: HTMLInputElement) => { colsInputEl = el; }}
        type="number"
        min="1"
        max="8"
        value="3"
        style="width:64px"
        class="y-input"
        onchange=${() => {
          const v = Math.max(1, Math.min(8, Number(colsInputEl.value) || 3));
          colsInputEl.value = String(v);
          setColumns(v);
          setStatus(`${images().length} image(s) loaded · mode=${mode()}${mode() === 'grid' ? ` · cols=${v}` : ''}`);
        }}
      /></label>
      <button class="y-btn y-btn-sm y-btn-danger" onClick=${() => setImages([], true)}>Clear</button>
    </div>
    <div class="main">
      <aside class="sidebar">
        <div class="side-head y-p-2 y-text-xs y-text-muted y-border-b">Loaded Images</div>
        <div class="thumbs y-scroll">
          <${Show} when=${() => images().length === 0}>
            <div class="empty">No images loaded.</div>
          </${Show}>
          <${For} each=${images}>${(item: ImageItem) => html`
            <button class=${() => 'thumb' + (selectedIds().has(item.id) ? ' active' : '')} onClick=${() => selectImage(item)}>
              <img src="${item.source}" alt="${item.name}"/>
              <div>${item.name}</div>
            </button>
          `}</${For}>
        </div>
      </aside>
      <div class="viewer-wrap">
        <div style="width:100%;min-height:0;">
          <${Show} when=${() => images().length === 0}>
            <div class="empty">Load files or send images via App Protocol.</div>
          </${Show}>
          <${Show} when=${() => images().length > 0}>
            <div
              class=${() => mode() === 'single' ? 'viewer-single' : 'viewer-grid'}
              style=${() => mode() === 'grid' ? `--cols:${Math.max(1, columns())}` : ''}
            >
              <${For} each=${getShowItems}>${(item: ImageItem) => html`
                <div class="panel">
                  <div class="panel-head">${item.name}</div>
                  <img src="${item.source}" alt="${item.name}"/>
                </div>
              `}</${For}>
            </div>
          </${Show}>
        </div>
      </div>
    </div>
    <div class="status y-text-xs y-text-muted">${() => status()}</div>
  </div>
`, document.getElementById('app')!);

if (appApi) {
  setupProtocol(appApi, {
    images,
    setImages_,
    selectedIds,
    setSelectedIds,
    mode,
    setMode,
    columns,
    setColumns,
    status,
    setStatus,
    getColsInputEl: () => colsInputEl,
    setImages,
    normalizeInputImage,
    loadStoragePaths,
    loadAllStorageImages,
  });
}
