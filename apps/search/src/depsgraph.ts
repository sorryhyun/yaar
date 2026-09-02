export {};
import { createEffect, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { renderMermaid } from '@bundled/mermaid';
import { errMsg, showToast } from '@bundled/yaar';
import { state, setState } from './store';
import { previewDepsFile, clearDepsGraph } from './deps';

/**
 * Renders the last `analyze-deps mode: "mermaid"` report as an actual diagram.
 *
 * renderMermaid() from '@bundled/mermaid' already applies the YAAR design tokens and
 * returns SANITIZED svg — it must not be passed through sanitizeHtml, which would strip
 * the <style> block the diagram themes itself with. Rendering needs a live document, so
 * it runs from an effect after mount, never during it.
 */

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 4;

function clampZoom(z: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
}

export const DepsPanel = () => {
  let canvasEl: HTMLDivElement | undefined;
  let sizerEl: HTMLDivElement | undefined;
  let hostEl: HTMLDivElement | undefined;
  /** Intrinsic svg size, read off the viewBox once per render. */
  let natW = 0;
  let natH = 0;
  /** Guards against a slow render landing after a newer one. */
  let renderToken = 0;

  async function renderSource(source: string) {
    const token = ++renderToken;
    setState('depsRendering', true);
    setState('depsError', null);
    try {
      const svg = await renderMermaid(source);
      if (token !== renderToken) return;
      setState('depsSvg', svg);
    } catch (e: unknown) {
      if (token !== renderToken) return;
      setState('depsSvg', null);
      setState('depsError', errMsg(e));
    } finally {
      if (token === renderToken) setState('depsRendering', false);
    }
  }

  /** Pin the svg to its viewBox size so transform-scale zooming is predictable. */
  function measureSvg() {
    natW = 0;
    natH = 0;
    const svg = hostEl?.querySelector('svg');
    if (!svg) return;
    const vb = (svg.getAttribute('viewBox') ?? '')
      .split(/[\s,]+/)
      .map(Number)
      .filter((n) => Number.isFinite(n));
    if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
      natW = vb[2];
      natH = vb[3];
      svg.setAttribute('width', String(natW));
      svg.setAttribute('height', String(natH));
    }
    svg.style.maxWidth = 'none';
  }

  function nodeLabel(nodeEl: Element): string {
    const label = nodeEl.querySelector('.nodeLabel, .label');
    return (label?.textContent ?? nodeEl.textContent ?? '').trim();
  }

  /** Mark which nodes are files (clickable) and which one is currently previewed. */
  function paintNodes() {
    if (!hostEl) return;
    const files = state.depsGraph?.files ?? [];
    const selected = state.depsSelectedFile;
    hostEl.querySelectorAll('g.node').forEach((n) => {
      const label = nodeLabel(n);
      n.classList.toggle('deps-node-clickable', files.includes(label));
      n.classList.toggle('deps-node-selected', !!selected && label === selected);
    });
  }

  function applyZoom() {
    const z = state.depsZoom;
    if (hostEl) {
      hostEl.style.transform = `scale(${z})`;
      hostEl.style.transformOrigin = '0 0';
    }
    if (sizerEl && natW && natH) {
      sizerEl.style.width = `${Math.round(natW * z)}px`;
      sizerEl.style.height = `${Math.round(natH * z)}px`;
    }
  }

  function zoomBy(factor: number) {
    setState('depsZoom', clampZoom(state.depsZoom * factor));
  }

  function fitToView() {
    if (!canvasEl || !natW || !natH) {
      setState('depsZoom', 1);
      return;
    }
    const box = canvasEl.getBoundingClientRect();
    const raw = Math.min((box.width - 24) / natW, (box.height - 24) / natH);
    // Never fit so far out that the labels stop being readable — pan/zoom covers the rest.
    const z = Number.isFinite(raw) && raw > 0 ? Math.max(0.5, Math.min(raw, 1.5)) : 1;
    setState('depsZoom', clampZoom(z));
  }

  function onWheel(e: WheelEvent) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12);
  }

  // Drag-to-pan: adjust scroll rather than transform, so the scrollbars stay honest.
  let panning = false;
  let panX = 0;
  let panY = 0;
  let panLeft = 0;
  let panTop = 0;

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0 || !canvasEl) return;
    if ((e.target as Element | null)?.closest?.('g.node')) return;
    panning = true;
    panX = e.clientX;
    panY = e.clientY;
    panLeft = canvasEl.scrollLeft;
    panTop = canvasEl.scrollTop;
    canvasEl.classList.add('panning');
    canvasEl.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent) {
    if (!panning || !canvasEl) return;
    canvasEl.scrollLeft = panLeft - (e.clientX - panX);
    canvasEl.scrollTop = panTop - (e.clientY - panY);
  }

  function onPointerUp(e: PointerEvent) {
    if (!panning || !canvasEl) return;
    panning = false;
    canvasEl.classList.remove('panning');
    try {
      canvasEl.releasePointerCapture(e.pointerId);
    } catch {
      /* capture may already be gone */
    }
  }

  function onGraphClick(e: MouseEvent) {
    const nodeEl = (e.target as Element | null)?.closest?.('g.node');
    if (!nodeEl) return;
    const label = nodeLabel(nodeEl);
    const graph = state.depsGraph;
    if (!label || !graph || !graph.files.includes(label)) return;
    setState('depsSelectedFile', label);
    paintNodes();
    void previewDepsFile(label);
  }

  async function copySource() {
    const src = state.depsGraph?.mermaid;
    if (!src) return;
    try {
      await navigator.clipboard.writeText(src);
      showToast('Mermaid source copied', 'success');
      return;
    } catch {
      /* clipboard API is often unavailable in a sandboxed frame — fall through */
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = src;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      showToast(
        ok ? 'Mermaid source copied' : 'Copy blocked — use Source and copy manually',
        ok ? 'success' : 'error',
      );
    } catch (e: unknown) {
      showToast(`Copy failed: ${errMsg(e)}`, 'error');
    }
  }

  // Render whenever the diagram source changes.
  createEffect(() => {
    const graph = state.depsGraph;
    if (!graph) {
      renderToken++;
      return;
    }
    void renderSource(graph.mermaid);
  });

  // Insert the rendered svg, then measure and fit it.
  createEffect(() => {
    const svg = state.depsSvg;
    if (!hostEl) return;
    hostEl.innerHTML = svg ?? '';
    if (!svg) return;
    measureSvg();
    paintNodes();
    fitToView();
    applyZoom();
  });

  createEffect(() => {
    state.depsZoom;
    applyZoom();
  });

  createEffect(() => {
    state.depsSelectedFile;
    paintNodes();
  });

  return html`
    <div class="deps-panel">
      <div class="y-toolbar deps-toolbar">
        <span class="deps-title y-truncate" title=${() => state.depsGraph?.display ?? ''}>
          🕸 ${() => state.depsGraph?.display ?? ''}
        </span>
        <div class="deps-actions">
          <button
            class=${() => `y-btn y-btn-sm${state.depsShowSource ? ' y-btn-primary' : ''}`}
            title="Toggle between the rendered diagram and its mermaid source"
            onClick=${() => setState('depsShowSource', !state.depsShowSource)}
          >
            ${() => (state.depsShowSource ? 'Diagram' : 'Source')}
          </button>
          <button class="y-btn y-btn-sm" title="Copy mermaid source" onClick=${copySource}>
            Copy
          </button>
          <button class="y-btn y-btn-sm" title="Zoom out" onClick=${() => zoomBy(1 / 1.25)}>−</button>
          <button class="y-btn y-btn-sm deps-zoom" title="Fit to window" onClick=${fitToView}>
            ${() => `${Math.round(state.depsZoom * 100)}%`}
          </button>
          <button class="y-btn y-btn-sm" title="Zoom in" onClick=${() => zoomBy(1.25)}>+</button>
          <button class="preview-close" title="Close diagram" onClick=${clearDepsGraph}>✕</button>
        </div>
      </div>

      <div class="deps-meta">
        <span class="y-truncate">
          <b>${() => state.depsGraph?.focus ?? ''}</b>
          <span>${() => {
            const g = state.depsGraph;
            return g ? ` · depth ${g.depth} · ${g.nodeCount} nodes · ${g.edgeCount} edges` : '';
          }}</span>
        </span>
        <span class="deps-legend">solid = import · dotted = type-only · red = cycle edge</span>
      </div>

      <${Show} when=${() => state.depsGraph?.truncated}>
        <div class="deps-warning">Diagram truncated to the nearest nodes — lower depth for a complete view.</div>
      <//>
      <${Show} when=${() => (state.depsGraph?.warnings.length ?? 0) > 0}>
        <div class="deps-warning">${() => (state.depsGraph?.warnings ?? []).join(' · ')}</div>
      <//>

      <div class="deps-body">
        <div
          class="deps-canvas y-scroll"
          style=${() => (state.depsShowSource ? 'display:none' : '')}
          ref=${(el: HTMLDivElement) => {
            canvasEl = el;
          }}
          onWheel=${onWheel}
          onPointerDown=${onPointerDown}
          onPointerMove=${onPointerMove}
          onPointerUp=${onPointerUp}
          onPointerCancel=${onPointerUp}
          onClick=${onGraphClick}
          onDblClick=${fitToView}
        >
          <div
            class="deps-sizer"
            ref=${(el: HTMLDivElement) => {
              sizerEl = el;
            }}
          >
            <div
              class="deps-graph"
              ref=${(el: HTMLDivElement) => {
                hostEl = el;
              }}
            ></div>
          </div>
        </div>

        <${Show} when=${() => state.depsShowSource}>
          <pre class="deps-source y-scroll">${() => state.depsGraph?.mermaid ?? ''}</pre>
        <//>

        <${Show} when=${() => !state.depsShowSource && state.depsRendering && !state.depsSvg}>
          <div class="deps-status">Rendering diagram…</div>
        <//>

        <${Show} when=${() => !state.depsShowSource && !!state.depsError}>
          <div class="deps-status deps-status-error">
            <div class="deps-status-title">⚠ Mermaid could not render this diagram</div>
            <div class="deps-status-msg">${() => state.depsError ?? ''}</div>
            <div class="deps-status-actions">
              <button class="y-btn y-btn-sm" onClick=${() => setState('depsShowSource', true)}>
                View source
              </button>
              <button class="y-btn y-btn-sm" onClick=${copySource}>Copy source</button>
              <button
                class="y-btn y-btn-sm y-btn-primary"
                onClick=${() => {
                  const g = state.depsGraph;
                  if (g) void renderSource(g.mermaid);
                }}
              >
                Retry
              </button>
            </div>
          </div>
        <//>
      </div>

      <div class="deps-hint">Click a node to preview that file · drag to pan · Ctrl+wheel to zoom</div>
    </div>
  `;
};
