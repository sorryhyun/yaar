import { createEffect, createSignal, For, Show, onCleanup } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { showToast, errMsg } from '@bundled/yaar';
import { MODELS, type ModelChoice } from '../model';
import { loadFromDataTransfer, pickFile } from '../image-input';
import { loadSample } from '../sample';
import { runRecognition } from '../recognize';
import {
  backend,
  busy,
  downloadRatio,
  error,
  imageSize,
  modelId,
  results,
  selection,
  setModelId,
  setSelection,
  sourceCanvas,
  status,
  type OcrRecord,
  type Rect,
} from '../state';

/** Drag origin in image coordinates; lives outside the store until it settles. */
interface Drag {
  x: number;
  y: number;
}

export function App() {
  let canvasRef: HTMLCanvasElement | undefined;
  const [drag, setDrag] = createSignal<Drag | null>(null);
  const [dragRect, setDragRect] = createSignal<Rect | null>(null);

  // Repaint the display canvas whenever a new image lands.
  createEffect(() => {
    const size = imageSize();
    const src = sourceCanvas();
    if (!canvasRef || !src || !size) return;
    canvasRef.width = size.w;
    canvasRef.height = size.h;
    canvasRef.getContext('2d')?.drawImage(src, 0, 0);
  });

  const onPaste = async (e: ClipboardEvent) => {
    try {
      if (await loadFromDataTransfer(e.clipboardData)) e.preventDefault();
    } catch (err) {
      showToast(errMsg(err), 'error');
    }
  };
  window.addEventListener('paste', onPaste);
  onCleanup(() => window.removeEventListener('paste', onPaste));

  /** Client coordinates → image pixel coordinates. */
  const toImage = (clientX: number, clientY: number) => {
    const size = imageSize();
    if (!canvasRef || !size) return null;
    const box = canvasRef.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return null;
    return {
      x: ((clientX - box.left) / box.width) * size.w,
      y: ((clientY - box.top) / box.height) * size.h,
    };
  };

  const onPointerDown = (e: PointerEvent) => {
    const point = toImage(e.clientX, e.clientY);
    if (!point) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag(point);
    setDragRect({ x: point.x, y: point.y, w: 0, h: 0 });
  };

  const onPointerMove = (e: PointerEvent) => {
    const origin = drag();
    if (!origin) return;
    const point = toImage(e.clientX, e.clientY);
    if (!point) return;
    setDragRect({
      x: Math.min(origin.x, point.x),
      y: Math.min(origin.y, point.y),
      w: Math.abs(point.x - origin.x),
      h: Math.abs(point.y - origin.y),
    });
  };

  const onPointerUp = () => {
    const rect = dragRect();
    setDrag(null);
    setDragRect(null);
    // A click with no drag clears the selection rather than selecting one pixel.
    setSelection(rect && rect.w >= 4 && rect.h >= 4 ? rect : null);
  };

  /** The box to paint: whatever is being dragged, else the committed selection. */
  const overlayStyle = () => {
    const rect = dragRect() ?? selection();
    const size = imageSize();
    if (!rect || !size) return 'display:none';
    const pct = (v: number, total: number) => `${(v / total) * 100}%`;
    return [
      `left:${pct(rect.x, size.w)}`,
      `top:${pct(rect.y, size.h)}`,
      `width:${pct(rect.w, size.w)}`,
      `height:${pct(rect.h, size.h)}`,
    ].join(';');
  };

  const recognize = async () => {
    try {
      await runRecognition();
    } catch (err) {
      showToast(errMsg(err), 'error');
    }
  };

  const copyLatest = async () => {
    const text = results()[0]?.text;
    if (!text) return;
    await navigator.clipboard.writeText(text);
    showToast('Copied', 'success');
  };

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    try {
      if (!(await loadFromDataTransfer(e.dataTransfer)))
        showToast('That was not an image', 'error');
    } catch (err) {
      showToast(errMsg(err), 'error');
    }
  };

  return html`<div class="y-app ocr-root">
    <div class="y-toolbar">
      <button class="y-btn" onClick=${() => pickFile()}>Open image…</button>
      <button class="y-btn y-btn-ghost" onClick=${() => loadSample()}>Sample</button>
      <div class="y-tsep"></div>
      <select
        class="y-select"
        value=${() => modelId()}
        disabled=${() => busy()}
        onChange=${(e: Event) => setModelId((e.currentTarget as HTMLSelectElement).value)}
      >
        <${For} each=${MODELS}
          >${(m: ModelChoice) => html`<option value=${m.id}>${m.label}</option>`}<//
        >
      </select>
      <button
        class="y-btn y-btn-primary"
        disabled=${() => busy() || !imageSize()}
        onClick=${recognize}
      >
        ${() => (busy() ? 'Working…' : 'Recognize')}
      </button>
      <span class="ocr-spacer"></span>
      <span class="y-badge">${() => backend()}</span>
    </div>

    <div class="ocr-stage" onDragOver=${(e: DragEvent) => e.preventDefault()} onDrop=${onDrop}>
      <${Show}
        when=${() => imageSize()}
        fallback=${() =>
          html`<div class="y-empty">
            <div class="y-empty-icon">🔎</div>
            <div>Drop an image here, paste one, or press <b>Sample</b>.</div>
            <div class="ocr-hint">
              Then drag a box over a single line of text and press Recognize.
            </div>
          </div>`}
      >
        <div class="ocr-canvas-wrap">
          <canvas
            class="ocr-canvas"
            ref=${(el: HTMLCanvasElement) => (canvasRef = el)}
            onPointerDown=${onPointerDown}
            onPointerMove=${onPointerMove}
            onPointerUp=${onPointerUp}
          ></canvas>
          <div class="ocr-selection" style=${overlayStyle}></div>
        </div>
      <//>
    </div>

    <div class="ocr-panel">
      <div class="ocr-statusline">
        <span class="ocr-status">${() => status()}</span>
        <${Show} when=${() => downloadRatio() !== null}>
          <div class="ocr-progress">
            <div
              class="ocr-progress-fill"
              style=${() => `width:${Math.round((downloadRatio() ?? 0) * 100)}%`}
            ></div>
          </div>
        <//>
      </div>

      <${Show} when=${() => error()}>
        <div class="ocr-error">${() => error()}</div>
      <//>

      <${Show} when=${() => results().length > 0}>
        <div class="ocr-results">
          <div class="ocr-results-head">
            <span class="y-label">Results</span>
            <button class="y-btn y-btn-ghost" onClick=${copyLatest}>Copy latest</button>
          </div>
          <div class="ocr-results-list">
            <${For} each=${() => results()}
              >${(r: OcrRecord) =>
                html`<div class="y-list-item ocr-result">
                  <div class="ocr-text">${r.text || '(nothing read)'}</div>
                  <div class="ocr-meta">
                    ${Math.round(r.confidence * 100)}% · ${r.modelId} · ${Math.round(r.elapsedMs)}
                    ms · ${Math.round(r.rect.w)}×${Math.round(r.rect.h)}
                  </div>
                </div>`}<//
            >
          </div>
        </div>
      <//>
    </div>
  </div>`;
}
