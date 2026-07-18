export {};
import { createEffect, createSignal, onCleanup, onMount, Show, For } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import './styles.css';
import { DEFAULT_FILTERS, outputSize, type Filters } from './core/doc';
import { canvasToSource, dragToSourceRect, sourceToCanvasScale } from './core/geometry';
import { cloneMask, createMask, recount, stampDisc, stampLine, type Mask } from './core/mask';
import { ANIMATE_PIXEL_LIMIT, renderSelectionOverlay } from './core/overlay';
import { fitScale, renderToCanvas, type ExportFormat } from './core/render';
import { registerProtocol } from './protocol';
import { errMsg, showConfirm, showPrompt } from '@bundled/yaar';
import {
  brushSize,
  canRedo,
  canUndo,
  clearSelection,
  contiguous,
  deleteStorageFile,
  dispatch,
  doc,
  downloadExport,
  drawColor,
  drawSize,
  eraser,
  hasSelection,
  image,
  magicWandAt,
  openLocalFile,
  openStoragePath,
  redoEdit,
  refreshStorageFiles,
  revision,
  saveToStorage,
  selectAll,
  selectMode,
  setBrushSize,
  setContiguous,
  setDrawColor,
  setDrawSize,
  setEraser,
  setSelectMode,
  setStatus,
  setTolerance,
  setTool,
  status,
  storageFiles,
  tolerance,
  tool,
  undoEdit,
  type StorageFile,
  type Tool,
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

const TOOLS: Array<{ id: Tool; label: string }> = [
  { id: 'crop', label: 'Crop' },
  { id: 'wand', label: 'Wand' },
  { id: 'lasso', label: 'Lasso' },
  { id: 'draw', label: 'Draw' },
];

const SELECT_MODES: Array<{ id: 'replace' | 'add' | 'subtract'; label: string }> = [
  { id: 'replace', label: 'New' },
  { id: 'add', label: 'Add' },
  { id: 'subtract', label: 'Subtract' },
];

function App() {
  let canvasRef: HTMLCanvasElement | undefined;
  let overlayRef: HTMLCanvasElement | undefined;
  let paneRef: HTMLDivElement | undefined;

  const [dragRect, setDragRect] = createSignal<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);
  const [paneSize, setPaneSize] = createSignal({ w: 0, h: 0 });
  const [scale, setScale] = createSignal(1);
  const [antPhase, setAntPhase] = createSignal(0);
  const [dragging, setDragging] = createSignal(false);
  const [liveTick, setLiveTick] = createSignal(0);

  // The scratch mask a lasso drag mutates in place. Kept out of the Doc until
  // the pointer lifts, so one drag is one undo step rather than one per frame.
  let workMask: Mask | null = null;
  let strokePoints: Array<{ x: number; y: number }> | null = null;
  let lastCanvasPt: { x: number; y: number } | null = null;
  let dragStart: { x: number; y: number } | null = null;

  onMount(() => {
    if (!paneRef) return;
    const observer = new ResizeObserver(() => {
      const r = paneRef!.getBoundingClientRect();
      setPaneSize({ w: r.width, h: r.height });
    });
    observer.observe(paneRef);
    onCleanup(() => observer.disconnect());
  });

  onMount(() => {
    void refreshStorageFiles();
  });

  // Marching ants. Paused mid-drag, because the overlay is also where the live
  // brush stroke is painted and a repaint would wipe it.
  onMount(() => {
    const id = setInterval(() => {
      if (dragging() || !hasSelection()) return;
      const c = canvasRef;
      if (c && c.width * c.height > ANIMATE_PIXEL_LIMIT) return;
      setAntPhase((p) => (p + 1) % 8);
    }, 180);
    onCleanup(() => clearInterval(id));
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

  // The selection overlay, sized to match the preview canvas exactly.
  createEffect(() => {
    revision();
    antPhase();
    liveTick();
    paneSize();
    scale();
    const d = doc();
    const ov = overlayRef;
    const c = canvasRef;
    if (!ov || !c || !d) return;
    if (ov.width !== c.width || ov.height !== c.height) {
      ov.width = c.width;
      ov.height = c.height;
    }
    renderSelectionOverlay(ov, d, workMask ?? d.selection, antPhase());
  });

  function canvasPoint(e: PointerEvent): { x: number; y: number } {
    const rect = canvasRef!.getBoundingClientRect();
    // Client px -> canvas backing-store px.
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvasRef!.width,
      y: ((e.clientY - rect.top) / rect.height) * canvasRef!.height,
    };
  }

  function toSource(p: { x: number; y: number }): { x: number; y: number } {
    return canvasToSource(doc()!, canvasRef!.width, canvasRef!.height, p.x, p.y);
  }

  /**
   * Canvas px per source px. Brush sizes are authored in on-screen pixels and
   * converted through this, so a 12px brush looks 12px wide whatever the zoom —
   * while the stored stroke stays in source space and exports at full res.
   */
  function sourceScale(): number {
    return sourceToCanvasScale(doc()!, canvasRef!.width, canvasRef!.height) || 1;
  }

  function paintLive(from: { x: number; y: number }, to: { x: number; y: number }) {
    const r = brushSize() / 2 / sourceScale();
    stampLine(workMask!, from.x, from.y, to.x, to.y, r, selectMode() === 'subtract' ? 0 : 1);
    setLiveTick((n) => n + 1);
  }

  /** Live brush feedback, drawn straight onto the overlay in canvas space. */
  function strokeLive(a: { x: number; y: number }, b: { x: number; y: number }) {
    const ctx = overlayRef?.getContext('2d');
    if (!ctx) return;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1, drawSize());
    ctx.strokeStyle = eraser() ? 'rgba(255,255,255,0.55)' : drawColor();
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
  }

  function onPointerDown(e: PointerEvent) {
    const d = doc();
    const t = tool();
    if (!d || !canvasRef || t === 'none') return;
    canvasRef.setPointerCapture(e.pointerId);
    const p = canvasPoint(e);
    const s = toSource(p);

    if (t === 'crop') {
      dragStart = p;
      setDragRect({ x: p.x, y: p.y, w: 0, h: 0 });
      return;
    }

    if (t === 'wand') {
      try {
        magicWandAt(s.x, s.y);
      } catch (err) {
        setStatus(errMsg(err));
      }
      return;
    }

    if (t === 'lasso') {
      setDragging(true);
      // Subtract starts from the current selection; add and replace both build
      // up from it too, so a replace-mode drag is additive within one stroke.
      workMask = d.selection ? cloneMask(d.selection) : createMask(d.base.w, d.base.h);
      if (selectMode() === 'replace' && d.selection) workMask.data.fill(0);
      stampDisc(workMask, s.x, s.y, brushSize() / 2 / sourceScale(), selectMode() === 'subtract' ? 0 : 1);
      lastCanvasPt = p;
      setLiveTick((n) => n + 1);
      return;
    }

    if (t === 'draw') {
      setDragging(true);
      strokePoints = [s];
      lastCanvasPt = p;
      strokeLive(p, p);
    }
  }

  function onPointerMove(e: PointerEvent) {
    const t = tool();
    if (!canvasRef || !doc()) return;
    const p = canvasPoint(e);

    if (t === 'crop' && dragStart) {
      setDragRect({
        x: Math.min(dragStart.x, p.x),
        y: Math.min(dragStart.y, p.y),
        w: Math.abs(p.x - dragStart.x),
        h: Math.abs(p.y - dragStart.y),
      });
      return;
    }

    if (t === 'lasso' && workMask && lastCanvasPt) {
      paintLive(toSource(lastCanvasPt), toSource(p));
      lastCanvasPt = p;
      return;
    }

    if (t === 'draw' && strokePoints && lastCanvasPt) {
      strokePoints.push(toSource(p));
      strokeLive(lastCanvasPt, p);
      lastCanvasPt = p;
    }
  }

  function onPointerUp(e: PointerEvent) {
    const d = doc();
    const t = tool();
    if (!canvasRef || !d) return;
    canvasRef.releasePointerCapture(e.pointerId);
    const p = canvasPoint(e);

    if (t === 'crop' && dragStart) {
      const start = dragStart;
      dragStart = null;
      setDragRect(null);
      // Ignore an accidental click — a few pixels is not a crop.
      if (Math.abs(p.x - start.x) < 4 || Math.abs(p.y - start.y) < 4) return;
      dispatch({ type: 'crop', rect: dragToSourceRect(d, canvasRef.width, canvasRef.height, start, p) });
      setTool('none');
      return;
    }

    if (t === 'lasso' && workMask) {
      const finished = recount(workMask);
      workMask = null;
      lastCanvasPt = null;
      setDragging(false);
      dispatch({ type: 'setSelection', mask: finished });
      setStatus(
        finished.count
          ? `Selection: ${finished.count.toLocaleString()} px`
          : 'Selection cleared.',
      );
      return;
    }

    if (t === 'draw' && strokePoints) {
      const points = strokePoints;
      strokePoints = null;
      lastCanvasPt = null;
      setDragging(false);
      dispatch({
        type: 'draw',
        stroke: {
          color: drawColor(),
          size: Math.max(1, drawSize() / sourceScale()),
          erase: eraser(),
          points,
        },
      });
    }
  }

  async function doExport(format: ExportFormat) {
    try {
      await downloadExport(format);
    } catch (e) {
      setStatus(errMsg(e));
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
      setStatus(errMsg(e));
    }
  }

  async function removeFile(file: StorageFile) {
    if (!(await showConfirm(`Delete “${file.name}” from storage?`))) return;
    try {
      await deleteStorageFile(file.path);
    } catch (e) {
      setStatus(errMsg(e));
    }
  }

  function setFilter(key: keyof Filters, value: number) {
    dispatch({ type: 'filter', values: { [key]: value } });
  }

  function removeSelection() {
    dispatch({ type: 'removeSelection' });
    setStatus('Selection removed — export as PNG to keep the transparency.');
  }

  const hasDoc = () => doc() != null;
  const activeTool = (id: Tool) => tool() === id;

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

        <${For} each=${TOOLS}>
          ${(t: (typeof TOOLS)[number]) => html`
            <button
              class=${() => `y-btn y-btn-sm ${activeTool(t.id) ? 'y-btn-primary' : ''}`}
              disabled=${() => !hasDoc()}
              onClick=${() => setTool(activeTool(t.id) ? 'none' : t.id)}
            >
              ${t.label}
            </button>
          `}
        <//>
        <button
          class="y-btn y-btn-sm"
          disabled=${() => !doc()?.crop}
          onClick=${() => dispatch({ type: 'uncrop' })}
        >
          Uncrop
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
        <button class="y-btn y-btn-sm" disabled=${() => !hasDoc()} onClick=${() => doExport('jpeg')}>
          JPEG
        </button>
      </div>

      <div class="main">
        <aside class="sidebar y-scroll">
          <div class="section">
            <div class="y-label">Selection</div>

            <div class="control">
              <div class="control-head">
                <span>Tolerance</span>
                <span class="y-text-muted">${() => tolerance()}</span>
              </div>
              <input
                type="range"
                min="0"
                max="128"
                step="1"
                disabled=${() => !hasDoc()}
                value=${() => tolerance()}
                oninput=${(e: Event) => setTolerance(Number((e.target as HTMLInputElement).value))}
              />
            </div>

            <div class="seg">
              <button
                class=${() => `y-btn y-btn-sm ${contiguous() ? 'y-btn-primary' : ''}`}
                onClick=${() => setContiguous(true)}
              >
                Contiguous
              </button>
              <button
                class=${() => `y-btn y-btn-sm ${!contiguous() ? 'y-btn-primary' : ''}`}
                onClick=${() => setContiguous(false)}
              >
                Global
              </button>
            </div>

            <div class="seg">
              <${For} each=${SELECT_MODES}>
                ${(m: (typeof SELECT_MODES)[number]) => html`
                  <button
                    class=${() => `y-btn y-btn-sm ${selectMode() === m.id ? 'y-btn-primary' : ''}`}
                    onClick=${() => setSelectMode(m.id)}
                  >
                    ${m.label}
                  </button>
                `}
              <//>
            </div>

            <div class="control">
              <div class="control-head">
                <span>Lasso brush</span>
                <span class="y-text-muted">${() => brushSize()}px</span>
              </div>
              <input
                type="range"
                min="2"
                max="120"
                step="1"
                disabled=${() => !hasDoc()}
                value=${() => brushSize()}
                oninput=${(e: Event) => setBrushSize(Number((e.target as HTMLInputElement).value))}
              />
            </div>

            <div class="btn-grid">
              <button
                class="y-btn y-btn-sm"
                disabled=${() => !hasSelection()}
                onClick=${() => dispatch({ type: 'cropToSelection' })}
              >
                Crop to selection
              </button>
              <button
                class="y-btn y-btn-sm"
                disabled=${() => !hasSelection()}
                onClick=${removeSelection}
              >
                Remove selection
              </button>
              <button
                class="y-btn y-btn-sm"
                disabled=${() => !hasDoc()}
                onClick=${() => dispatch({ type: 'invertSelection' })}
              >
                Invert selection
              </button>
              <button class="y-btn y-btn-sm" disabled=${() => !hasDoc()} onClick=${() => selectAll()}>
                Select all
              </button>
              <button
                class="y-btn y-btn-sm y-btn-ghost"
                disabled=${() => !hasSelection()}
                onClick=${() => clearSelection()}
              >
                Clear selection
              </button>
              <button
                class="y-btn y-btn-sm y-btn-ghost"
                disabled=${() => !doc()?.removed}
                onClick=${() => dispatch({ type: 'restoreRemoved' })}
              >
                Restore removed
              </button>
            </div>

            <div class="y-text-xs y-text-muted">
              Wand clicks a colour; Lasso drags a free shape. Remove exports transparent as PNG.
            </div>
          </div>

          <div class="section">
            <div class="y-label">Draw</div>
            <div class="draw-row">
              <input
                type="color"
                class="color-input"
                disabled=${() => !hasDoc()}
                value=${() => drawColor()}
                oninput=${(e: Event) => setDrawColor((e.target as HTMLInputElement).value)}
              />
              <button
                class=${() => `y-btn y-btn-sm ${eraser() ? 'y-btn-primary' : ''}`}
                disabled=${() => !hasDoc()}
                onClick=${() => setEraser(!eraser())}
              >
                Eraser
              </button>
            </div>
            <div class="control">
              <div class="control-head">
                <span>Brush size</span>
                <span class="y-text-muted">${() => drawSize()}px</span>
              </div>
              <input
                type="range"
                min="1"
                max="120"
                step="1"
                disabled=${() => !hasDoc()}
                value=${() => drawSize()}
                oninput=${(e: Event) => setDrawSize(Number((e.target as HTMLInputElement).value))}
              />
            </div>
            <button
              class="y-btn y-btn-sm y-btn-ghost"
              disabled=${() => !doc()?.strokes.length}
              onClick=${() => dispatch({ type: 'clearStrokes' })}
            >
              Clear drawing
            </button>
          </div>

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
                class=${() => `canvas ${tool() !== 'none' ? 'active-tool' : ''}`}
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
              <canvas
                ref=${(el: HTMLCanvasElement) => (overlayRef = el)}
                class="overlay"
                style=${() => {
                  const d = doc();
                  if (!d) return 'display:none';
                  const out = outputSize(d);
                  return `width:${Math.round(out.w * scale())}px;height:${Math.round(out.h * scale())}px`;
                }}
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
