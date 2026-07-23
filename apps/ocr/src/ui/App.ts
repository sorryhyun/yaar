import { createEffect, createSignal, For, Show, onCleanup } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { showToast, errMsg } from '@bundled/yaar';
import { loadFromDataTransfer, pickFile } from '../image-input';
import { loadSample } from '../sample';
import { runRecognition } from '../recognize';
import { runPageRead, type PageLine } from '../pipeline';
import {
  activeLine,
  backend,
  busy,
  downloadRatio,
  error,
  imageSize,
  page,
  results,
  selection,
  setActiveLine,
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

  const readPage = async () => {
    try {
      await runPageRead();
    } catch (err) {
      showToast(errMsg(err), 'error');
    }
  };

  const copy = async (text: string | undefined) => {
    if (!text) return;
    await navigator.clipboard.writeText(text);
    showToast('Copied', 'success');
  };

  /**
   * Place a detected box over the canvas.
   *
   * The box is anchored at its top-left corner and rotated about it, rather than
   * drawn as its bounding rectangle — a tilted line's bounding box is visibly bigger
   * than the crop the recognizer actually read, which would make a correct detection
   * look sloppy. Percentages track the canvas as it scales with the window.
   */
  const boxStyle = (line: PageLine) => {
    const size = imageSize();
    if (!size) return 'display:none';
    const [p0, p1, , p3] = line.quad;
    const w = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const h = Math.hypot(p3.x - p0.x, p3.y - p0.y);
    return [
      `left:${(p0.x / size.w) * 100}%`,
      `top:${(p0.y / size.h) * 100}%`,
      `width:${(w / size.w) * 100}%`,
      `height:${(h / size.h) * 100}%`,
      `transform:rotate(${line.box.angle}deg)`,
    ].join(';');
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
      <button class="y-btn" disabled=${() => busy() || !imageSize()} onClick=${recognize}>
        ${() => (busy() ? 'Working…' : 'Read selection')}
      </button>
      <button
        class="y-btn y-btn-primary"
        disabled=${() => busy() || !imageSize()}
        onClick=${readPage}
      >
        ${() => (busy() ? 'Working…' : 'Read page')}
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
              Then press <b>Read page</b> — or drag a box over one line and press
              <b>Read selection</b>.
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
          <${Show} when=${() => page()}>
            <div class="ocr-boxes">
              <${For} each=${() => page()?.lines ?? []}
                >${(line: PageLine, i: () => number) =>
                  html`<button
                    class=${() =>
                      [
                        'ocr-box',
                        line.readable ? '' : 'ocr-box-unread',
                        activeLine() === i() ? 'ocr-box-active' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    style=${() => boxStyle(line)}
                    title=${line.text || 'detected, but nothing readable here'}
                    onClick=${() => setActiveLine(activeLine() === i() ? null : i())}
                  ></button>`}<//
              >
            </div>
          <//>
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

      <${Show} when=${() => page()}>
        <div class="ocr-results">
          <div class="ocr-results-head">
            <span class="y-label">
              Whole page ·
              ${() => {
                const p = page()!;
                const parts = [`${p.lines.length} lines`];
                if (p.unreadable) parts.push(`${p.unreadable} unreadable`);
                if (p.truncated) parts.push('partial (box limit)');
                parts.push(`${Math.round(p.elapsedMs)} ms`);
                return parts.join(' · ');
              }}
            </span>
            <button class="y-btn y-btn-ghost" onClick=${() => copy(page()?.text)}>Copy page</button>
          </div>
          <${Show} when=${() => activeLine() !== null && page()?.lines[activeLine()!]}>
            <div class="y-list-item ocr-result ocr-line-detail">
              <div class="ocr-text">
                ${() => page()!.lines[activeLine()!].text || '(nothing readable in this box)'}
              </div>
              <div class="ocr-meta">
                line ${() => activeLine()! + 1} ·
                ${() => Math.round(page()!.lines[activeLine()!].confidence * 100)}% read ·
                ${() => Math.round(page()!.lines[activeLine()!].score * 100)}% detected
              </div>
            </div>
          <//>
          <div class="ocr-text ocr-page-text">
            ${() => page()!.text || '(detected boxes, but nothing readable — check the script)'}
          </div>
        </div>
      <//>

      <${Show} when=${() => results().length > 0}>
        <div class="ocr-results">
          <div class="ocr-results-head">
            <span class="y-label">Selection reads</span>
            <button class="y-btn y-btn-ghost" onClick=${() => copy(results()[0]?.text)}>
              Copy latest
            </button>
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
