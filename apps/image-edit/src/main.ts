export {};
import { createEffect, createSignal, onCleanup, onMount, Show, For } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import './styles.css';
import { DEFAULT_FILTERS, outputSize, type Filters } from './core/doc';
import { dragToSourceRect } from './core/geometry';
import { fitScale, renderToCanvas, type ExportFormat } from './core/render';
import { registerProtocol } from './protocol';
import { showConfirm, showPrompt } from '@bundled/yaar';
import {
  canRedo,
  canUndo,
  deleteStorageFile,
  dispatch,
  doc,
  downloadExport,
  image,
  openLocalFile,
  openStoragePath,
  redoEdit,
  refreshStorageFiles,
  revision,
  saveToStorage,
  setStatus,
  status,
  storageFiles,
  undoEdit,
  type StorageFile,
} from './store';

const FILTER_CONTROLS: Array<{
  key: keyof Filters;
  label: string;
  min: number;
  max: number;
  step: number;
}> = [
  { key: 'brightness', label: 'Brightness', min: 0, max: 200, step: 1 },
  { key: 'contrast', label: 'Contrast', min: 0, max: 200, step: 1 },
  { key: 'saturation', label: 'Saturation', min: 0, max: 200, step: 1 },
  { key: 'blur', label: 'Blur', min: 0, max: 20, step: 0.1 },
];

function App() {
  let canvasRef: HTMLCanvasElement | undefined;
  let paneRef: HTMLDivElement | undefined;

  const [cropMode, setCropMode] = createSignal(false);
  const [dragRect, setDragRect] = createSignal<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);
  const [paneSize, setPaneSize] = createSignal({ w: 0, h: 0 });
  const [scale, setScale] = createSignal(1);

  // Track the pane so the preview refits when the window resizes.
  onMount(() => {
    if (!paneRef) return;
    const observer = new ResizeObserver(() => {
      const r = paneRef!.getBoundingClientRect();
      setPaneSize({ w: r.width, h: r.height });
    });
    observer.observe(paneRef);
    onCleanup(() => observer.disconnect());
  });

  // Populate the library up front — an empty panel with a Refresh button reads
  // as "no saved images" whether or not that is true.
  onMount(() => {
    void refreshStorageFiles();
  });

  // The preview. Same renderer as export, just at fit scale.
  createEffect(() => {
    revision();
    const d = doc();
    const img = image();
    const pane = paneSize();
    if (!canvasRef || !d || !img) return;
    const out = outputSize(d);
    const s = fitScale(out, Math.max(0, pane.w - 32), Math.max(0, pane.h - 32));
    setScale(s);
    renderToCanvas(canvasRef, d, img, s);
  });

  function canvasPoint(e: PointerEvent): { x: number; y: number } {
    const rect = canvasRef!.getBoundingClientRect();
    // Client px -> canvas backing-store px.
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvasRef!.width,
      y: ((e.clientY - rect.top) / rect.height) * canvasRef!.height,
    };
  }

  let dragStart: { x: number; y: number } | null = null;

  function onPointerDown(e: PointerEvent) {
    if (!cropMode() || !doc() || !canvasRef) return;
    dragStart = canvasPoint(e);
    setDragRect({ x: dragStart.x, y: dragStart.y, w: 0, h: 0 });
    canvasRef.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragStart || !canvasRef) return;
    const p = canvasPoint(e);
    setDragRect({
      x: Math.min(dragStart.x, p.x),
      y: Math.min(dragStart.y, p.y),
      w: Math.abs(p.x - dragStart.x),
      h: Math.abs(p.y - dragStart.y),
    });
  }

  function onPointerUp(e: PointerEvent) {
    if (!dragStart || !canvasRef) return;
    const end = canvasPoint(e);
    const start = dragStart;
    dragStart = null;
    setDragRect(null);
    canvasRef.releasePointerCapture(e.pointerId);

    // Ignore an accidental click — a few pixels is not a crop.
    if (Math.abs(end.x - start.x) < 4 || Math.abs(end.y - start.y) < 4) return;

    const d = doc();
    if (!d) return;
    const rect = dragToSourceRect(d, canvasRef.width, canvasRef.height, start, end);
    dispatch({ type: 'crop', rect });
    setCropMode(false);
  }

  async function doExport(format: ExportFormat) {
    try {
      await downloadExport(format);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Export failed.');
    }
  }

  async function doSaveToStorage() {
    const d = doc();
    if (!d) return;
    const suggested = `${d.base.name.replace(/\.[^.]+$/, '')}-edited`;
    const name = await showPrompt('Save to storage as:', { initial: suggested });
    if (name == null) return;
    try {
      await saveToStorage('png', name);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Save failed.');
    }
  }

  async function removeFile(file: StorageFile) {
    if (!(await showConfirm(`Delete “${file.name}” from storage?`))) return;
    try {
      await deleteStorageFile(file.path);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Delete failed.');
    }
  }

  function setFilter(key: keyof Filters, value: number) {
    dispatch({ type: 'filter', values: { [key]: value } });
  }

  const hasDoc = () => doc() != null;

  // Library thumbnails deliberately omit loading="lazy": inside the app iframe
  // the intersection check never fires, so lazy images stay blank forever.
  // Note also that HTML comments inside an `html` template misalign the
  // expression indices — keep notes like this one outside the template.

  return html`
    <div class="app y-app">
      <div class="toolbar y-toolbar">
        <label class="y-btn y-btn-sm file-btn">
          <span>Open</span>
          <input
            type="file"
            accept="image/*"
            onchange=${(e: Event) => {
              const file = (e.target as HTMLInputElement).files?.[0];
              if (file) openLocalFile(file);
            }}
          />
        </label>
        <button class="y-btn y-btn-sm" disabled=${() => !hasDoc()} onClick=${doSaveToStorage}>
          Save to storage
        </button>

        <span class="sep"></span>

        <button
          class="y-btn y-btn-sm"
          disabled=${() => !hasDoc()}
          onClick=${() => dispatch({ type: 'rotate', degrees: -90 })}
        >
          Rotate ⟲
        </button>
        <button
          class="y-btn y-btn-sm"
          disabled=${() => !hasDoc()}
          onClick=${() => dispatch({ type: 'rotate', degrees: 90 })}
        >
          Rotate ⟳
        </button>
        <button
          class="y-btn y-btn-sm"
          disabled=${() => !hasDoc()}
          onClick=${() => dispatch({ type: 'flip', axis: 'horizontal' })}
        >
          Flip H
        </button>
        <button
          class="y-btn y-btn-sm"
          disabled=${() => !hasDoc()}
          onClick=${() => dispatch({ type: 'flip', axis: 'vertical' })}
        >
          Flip V
        </button>

        <span class="sep"></span>

        <button
          class=${() => `y-btn y-btn-sm ${cropMode() ? 'y-btn-primary' : ''}`}
          disabled=${() => !hasDoc()}
          onClick=${() => setCropMode(!cropMode())}
        >
          Crop
        </button>
        <button
          class="y-btn y-btn-sm"
          disabled=${() => !doc()?.crop}
          onClick=${() => dispatch({ type: 'uncrop' })}
        >
          Uncrop
        </button>

        <span class="sep"></span>

        <button class="y-btn y-btn-sm" disabled=${() => !canUndo()} onClick=${() => undoEdit()}>
          Undo
        </button>
        <button class="y-btn y-btn-sm" disabled=${() => !canRedo()} onClick=${() => redoEdit()}>
          Redo
        </button>
        <button
          class="y-btn y-btn-sm y-btn-danger"
          disabled=${() => !hasDoc()}
          onClick=${() => dispatch({ type: 'reset' })}
        >
          Reset
        </button>

        <span class="spacer"></span>

        <button
          class="y-btn y-btn-sm y-btn-primary"
          disabled=${() => !hasDoc()}
          onClick=${() => doExport('png')}
        >
          Export PNG
        </button>
        <button
          class="y-btn y-btn-sm"
          disabled=${() => !hasDoc()}
          onClick=${() => doExport('jpeg')}
        >
          JPEG
        </button>
      </div>

      <div class="main">
        <aside class="sidebar y-scroll">
          <div class="section">
            <div class="library-head">
              <span class="y-label">Library</span>
              <button class="y-btn y-btn-sm y-btn-ghost" onClick=${() => refreshStorageFiles()}>
                Refresh
              </button>
            </div>
            <${Show}
              when=${() => storageFiles().length > 0}
              fallback=${() =>
                html`<div class="y-text-xs y-text-muted">
                  No saved images yet. Use “Save to storage”.
                </div>`}
            >
              <div class="library-grid">
                <${For} each=${storageFiles}>
                  ${(file: StorageFile) => html`
                    <div class="lib-item">
                      <button
                        class="lib-thumb"
                        title=${file.name}
                        onClick=${() => openStoragePath(file.path)}
                      >
                        <img src=${file.url} alt=${file.name} />
                        <span class="y-truncate lib-name">${file.name}</span>
                      </button>
                      <button class="lib-del" title="Delete" onClick=${() => removeFile(file)}>
                        ×
                      </button>
                    </div>
                  `}
                <//>
              </div>
            <//>
          </div>

          <div class="section">
            <div class="y-label">Filters</div>
            <${For} each=${FILTER_CONTROLS}>
              ${(control: (typeof FILTER_CONTROLS)[number]) => html`
                <div class="control">
                  <div class="control-head">
                    <span>${control.label}</span>
                    <span class="y-text-muted"
                      >${() =>
                        (
                          doc()?.filters[control.key] ?? DEFAULT_FILTERS[control.key]
                        ).toString()}</span
                    >
                  </div>
                  <input
                    type="range"
                    min=${control.min}
                    max=${control.max}
                    step=${control.step}
                    disabled=${() => !hasDoc()}
                    value=${() => doc()?.filters[control.key] ?? DEFAULT_FILTERS[control.key]}
                    oninput=${(e: Event) =>
                      setFilter(control.key, Number((e.target as HTMLInputElement).value))}
                  />
                </div>
              `}
            <//>
            <button
              class="y-btn y-btn-sm y-btn-ghost"
              disabled=${() => !hasDoc()}
              onClick=${() => dispatch({ type: 'resetFilters' })}
            >
              Reset filters
            </button>
          </div>

          <div class="section">
            <div class="y-label">Size</div>
            <div class="size-row">
              <input
                class="y-input"
                type="number"
                min="1"
                disabled=${() => !hasDoc()}
                value=${() => (doc() ? outputSize(doc()!).w : '')}
                onchange=${(e: Event) => {
                  const w = Number((e.target as HTMLInputElement).value);
                  if (w > 0) dispatch({ type: 'resize', width: w });
                }}
              />
              <span class="y-text-muted">×</span>
              <input
                class="y-input"
                type="number"
                min="1"
                disabled=${() => !hasDoc()}
                value=${() => (doc() ? outputSize(doc()!).h : '')}
                onchange=${(e: Event) => {
                  const h = Number((e.target as HTMLInputElement).value);
                  if (h > 0) dispatch({ type: 'resize', height: h });
                }}
              />
            </div>
            <div class="y-text-xs y-text-muted">Editing one dimension keeps the aspect ratio.</div>
          </div>
        </aside>

        <div class="pane" ref=${(el: HTMLDivElement) => (paneRef = el)}>
          <${Show}
            when=${hasDoc}
            fallback=${() => html`
              <div class="y-empty">
                <div class="y-empty-icon">🎨</div>
                <div>Open an image to start editing.</div>
              </div>
            `}
          >
            <div class="canvas-wrap">
              <canvas
                ref=${(el: HTMLCanvasElement) => (canvasRef = el)}
                class=${() => `canvas ${cropMode() ? 'cropping' : ''}`}
                style=${() => {
                  const d = doc();
                  if (!d) return '';
                  const out = outputSize(d);
                  return `width:${Math.round(out.w * scale())}px;height:${Math.round(out.h * scale())}px`;
                }}
                onpointerdown=${onPointerDown}
                onpointermove=${onPointerMove}
                onpointerup=${onPointerUp}
              ></canvas>
              <${Show} when=${dragRect}>
                <div
                  class="crop-rect"
                  style=${() => {
                    const r = dragRect();
                    const c = canvasRef;
                    if (!r || !c) return 'display:none';
                    // Backing-store px -> displayed px.
                    const k = c.clientWidth / c.width;
                    return `left:${r.x * k}px;top:${r.y * k}px;width:${r.w * k}px;height:${r.h * k}px`;
                  }}
                ></div>
              <//>
            </div>
          <//>
        </div>
      </div>

      <div class="statusbar y-text-xs y-text-muted">${status}</div>
    </div>
  `;
}

registerProtocol();
render(App, document.getElementById('app')!);
