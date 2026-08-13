import { createEffect, createMemo, createSignal, For, Show, onCleanup } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { showToast, errMsg } from '@bundled/yaar';
import { sliderVars } from '../graph/compile';
import { drawGraph, planSeries, defaultParams, formLabel, type SeriesPlan } from '../graph/render';
import { makeTransform, viewFromSpec, type View } from '../graph/sample';
import { graphToPNG } from '../lib/graph-render';
import { saveGraph, sharedPath } from '../lib/shared-tree';
import { downloadDataUrl } from '../lib/data-url';
import type { GraphSpec } from '../types';

/**
 * The interactive graph output: a device-pixel-ratio-aware canvas that re-samples
 * every string expression at whatever viewport the user has panned and zoomed to,
 * plus a slider per free variable.
 *
 * The viewport is deliberately NOT a signal. Panning fires at pointer rate, and a
 * signal there would push a full reactive update per frame; instead `view` is plain
 * local state and the handlers call draw() directly. The reactive half is only what
 * changes rarely: the spec, the compiled plans, and the parameter values.
 */
export function GraphView(props: { spec: GraphSpec }) {
  let canvasEl: HTMLCanvasElement | undefined;
  let view: View | null = null;
  // Whether the viewport on screen is the user's (panned/zoomed) or one derived
  // from the spec. A derived viewport is tied to the pixel size it was derived at,
  // so it must be thrown away on resize; a user's must survive.
  let userView = false;
  let W = 0;
  let H = 0;

  const [readout, setReadout] = createSignal('');
  const [params, setParams] = createSignal<Record<string, number>>({});
  const plans = createMemo<SeriesPlan[]>(() => planSeries(props.spec));
  const sliders = createMemo<string[]>(() => sliderVars(plans().map((p) => p.compiled)));
  const height = () => (props.spec.options && props.spec.options.height) || 360;

  /**
   * Sync the backing store to the CSS box. Returns false while the element has no
   * layout yet — a `ref` callback runs before the node is in the document, so the
   * first call always lands there and the ResizeObserver delivers the real size.
   */
  function measure(): boolean {
    if (!canvasEl) return false;
    const r = canvasEl.getBoundingClientRect();
    const w = Math.round(r.width);
    const h = Math.round(r.height);
    if (w < 2 || h < 2) return false;
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (w !== W || h !== H || canvasEl.width !== bw || canvasEl.height !== bh) {
      W = w;
      H = h;
      canvasEl.width = bw;
      canvasEl.height = bh;
      const ctx = canvasEl.getContext('2d');
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!userView) view = null;
    }
    return true;
  }

  function draw(): void {
    if (!canvasEl || !measure()) return;
    const ctx = canvasEl.getContext('2d');
    if (!ctx) return;
    if (!view) view = viewFromSpec(props.spec, W, H);
    drawGraph(ctx, W, H, props.spec, plans(), view, params());
  }

  // A new spec resets the parameters and the viewport; that setParams drives the
  // draw effect below, so this one never draws itself.
  createEffect(() => {
    const spec = props.spec;
    view = null;
    userView = false;
    setParams(defaultParams(spec, plans()));
  });

  createEffect(() => {
    props.spec;
    plans();
    params();
    draw();
  });

  const bounds = () => {
    if (!view || !W || !H) return undefined;
    const tr = makeTransform(view, W, H);
    return { xMin: tr.ux(0), xMax: tr.ux(W), yMin: tr.uy(H), yMax: tr.uy(0) };
  };

  function attach(el: HTMLCanvasElement): void {
    canvasEl = el;
    draw();

    const ro = new ResizeObserver(() => {
      measure();
      draw();
    });
    ro.observe(el);

    let drag: { x: number; y: number; cx: number; cy: number } | null = null;

    const onDown = (e: MouseEvent) => {
      if (!view) return;
      drag = { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy };
      e.preventDefault();
    };
    const onMove = (e: MouseEvent) => {
      if (!view) return;
      const r = el.getBoundingClientRect();
      const tr = makeTransform(view, W, H);
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (inside || drag) {
        setReadout(
          'x = ' + tr.ux(e.clientX - r.left).toFixed(3) + '   y = ' + tr.uy(e.clientY - r.top).toFixed(3),
        );
      } else if (readout()) {
        setReadout('');
      }
      if (!drag) return;
      view.cx = drag.cx - (e.clientX - drag.x) / view.sx;
      view.cy = drag.cy + (e.clientY - drag.y) / view.sy;
      userView = true;
      draw();
    };
    const onUp = () => {
      drag = null;
    };
    const onWheel = (e: WheelEvent) => {
      if (!view) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      const tr = makeTransform(view, W, H);
      const ux = tr.ux(mx);
      const uy = tr.uy(my);
      const k = Math.exp(-e.deltaY * 0.0015);
      // Clamp per-axis so a long fling cannot drive the scale to 0 or Infinity.
      view.sx = Math.min(1e7, Math.max(1e-5, view.sx * k));
      view.sy = Math.min(1e7, Math.max(1e-5, view.sy * k));
      // Anchor the zoom on the cursor: the point under it must not move.
      view.cx = ux - (mx - W / 2) / view.sx;
      view.cy = uy + (my - H / 2) / view.sy;
      userView = true;
      draw();
    };

    el.addEventListener('mousedown', onDown);
    el.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    onCleanup(() => {
      ro.disconnect();
      el.removeEventListener('mousedown', onDown);
      el.removeEventListener('wheel', onWheel);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    });
  }

  const reset = () => {
    view = null;
    userView = false;
    draw();
  };

  const setParam = (k: string, raw: string) => {
    const v = Number(raw);
    if (!isFinite(v)) return;
    setParams({ ...params(), [k]: v });
  };

  const save = async () => {
    try {
      const r = await saveGraph(props.spec, sharedPath(undefined, 'graph-' + Date.now()), {
        bounds: bounds(),
        params: params(),
      });
      showToast('Saved ' + r.path, 'success', 4000);
    } catch (e) {
      showToast('Save failed: ' + errMsg(e), 'error');
    }
  };

  const download = async () => {
    try {
      const png = await graphToPNG(props.spec, { bounds: bounds(), params: params() });
      downloadDataUrl(png, 'graph-' + Date.now() + '.png');
    } catch (e) {
      showToast('Export failed: ' + errMsg(e), 'error');
    }
  };

  return html`
    <div class="lab-graph-block">
      <div class="lab-graph" style=${() => 'height:' + height() + 'px'}>
        <canvas class="lab-graph-canvas" ref=${attach}></canvas>
        <div class="lab-graph-hud">${readout}</div>
        <div class="lab-graph-hint">drag to pan · wheel to zoom</div>
        <button class="lab-mini lab-graph-reset" onClick=${reset}>reset view</button>
      </div>
      <div class="lab-graph-legend">
        <${For} each=${plans}>
          ${(p: SeriesPlan) => html`
            <span class=${() => 'lab-graph-key' + (p.error ? ' lab-graph-key-bad' : '')} title=${() =>
              p.error || (p.resample ? formLabel(p.compiled) + ' · re-sampled on zoom' : 'sampled points · not re-sampled')}>
              <span class="lab-graph-sw" style=${() => 'background:' + p.color}></span>
              ${() => p.label}
              ${() => (p.error ? ' — ' + p.error : p.resample ? '' : ' (static)')}
            </span>`}
        <//>
      </div>
      <${Show} when=${() => sliders().length > 0}>
        <div class="lab-graph-sliders">
          <${For} each=${sliders}>
            ${(k: string) => html`
              <div class="lab-graph-slider">
                <span class="lab-graph-var">${k}</span>
                <input
                  type="range"
                  min="-10"
                  max="10"
                  step="0.01"
                  value=${() => String(params()[k] ?? 1)}
                  onInput=${(e: Event) => setParam(k, (e.currentTarget as HTMLInputElement).value)}
                />
                <input
                  class="lab-graph-num"
                  type="number"
                  step="0.1"
                  value=${() => String(params()[k] ?? 1)}
                  onChange=${(e: Event) => setParam(k, (e.currentTarget as HTMLInputElement).value)}
                />
              </div>`}
          <//>
        </div>
      <//>
      <div class="lab-chart-actions">
        <button class="lab-mini" onClick=${save}>Save to shared/lab</button>
        <button class="lab-mini" onClick=${download}>Download PNG</button>
      </div>
    </div>`;
}