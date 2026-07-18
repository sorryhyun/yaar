import { createEffect, createSignal, onCleanup, onMount, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import './styles.css';
import { outputSize } from './core/doc';
import { ANIMATE_PIXEL_LIMIT, renderSelectionOverlay } from './core/overlay';
import { fitScale, renderToCanvas } from './core/render';
import { registerProtocol } from './protocol';
import { doc, hasSelection, image, refreshStorageFiles, revision, status, tool } from './store';
import { hasDoc } from './ui/actions';
import { createPointerHandlers } from './ui/pointer';
import { Sidebar } from './ui/Sidebar';
import { Toolbar } from './ui/Toolbar';

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

  const pointer = createPointerHandlers({
    canvas: () => canvasRef,
    overlay: () => overlayRef,
    setDragRect: (r) => setDragRect(r),
    setDragging: (v) => setDragging(v),
    bumpLiveTick: () => setLiveTick((n) => n + 1),
  });

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
    renderSelectionOverlay(ov, d, pointer.workMask() ?? d.selection, antPhase());
  });

  return html`
    <div class="app y-app">
      <${Toolbar} />

      <div class="main">
        <${Sidebar} />

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
                onpointerdown=${pointer.onPointerDown}
                onpointermove=${pointer.onPointerMove}
                onpointerup=${pointer.onPointerUp}
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
