/**
 * Inspector.ts — transform / geometry / material for the selected node.
 * Every edit is routed through store.mutate() → applyOp. Nothing here touches
 * three.js directly.
 */
import html from '@bundled/solid-js/html';
import { Show, createMemo } from '@bundled/solid-js';
import { doc, mutate, reconciler, selectedNode, selection, warnings } from '../store';
import { rightDock as dock, railTitle } from './dock';
import type { MaterialDef, SceneNode, Vec3 } from '../scene-doc';

type Axis = 'x' | 'y' | 'z';
type Channel = 'p' | 'r' | 's';

const AXES: Axis[] = ['x', 'y', 'z'];

function fmt(v: number): string {
  if (!Number.isFinite(v)) return '0';
  const rounded = Math.round(v * 1000) / 1000;
  return String(rounded);
}

function commitVec(id: string, channel: Channel, axis: Axis, raw: string): void {
  const value = Number(raw);
  if (!Number.isFinite(value)) return;
  const patch: Partial<Vec3> = { [axis]: value } as Partial<Vec3>;
  if (channel === 'p') mutate({ type: 'setTransform', id, position: patch });
  else if (channel === 'r') mutate({ type: 'setTransform', id, rotation: patch });
  else mutate({ type: 'setTransform', id, scale: patch });
}

function vecRow(label: string, node: () => SceneNode, channel: Channel, step: number) {
  return html`<div class="row">
    <label>${label}</label>
    <div class="vec">
      ${AXES.map(
        (axis) => html`<input
          class="num"
          type="number"
          step=${String(step)}
          title=${`${label} ${axis.toUpperCase()}`}
          value=${() => fmt(node().transform[channel][axis])}
          onChange=${(e: Event) =>
            commitVec(node().id, channel, axis, (e.currentTarget as HTMLInputElement).value)}
        />`,
      )}
    </div>
  </div>`;
}

function slider(label: string, node: () => SceneNode, key: 'metalness' | 'roughness' | 'opacity') {
  return html`<div class="row">
    <label>${label}</label>
    <div style="display:grid;grid-template-columns:1fr 42px;gap:6px;align-items:center">
      <input
        type="range"
        min="0"
        max="1"
        step="0.01"
        value=${() => String(node().material?.[key] ?? 0)}
        onInput=${(e: Event) => {
          const v = Number((e.currentTarget as HTMLInputElement).value);
          mutate({ type: 'setMaterial', id: node().id, patch: { [key]: v } as Partial<MaterialDef> });
        }}
      />
      <span style="font-family:var(--yaar-font-mono);font-size:var(--yaar-text-xs);color:var(--yaar-text-dim)"
        >${() => (node().material?.[key] ?? 0).toFixed(2)}</span
      >
    </div>
  </div>`;
}

function toggle(
  label: string,
  node: () => SceneNode,
  key: 'wireframe' | 'flatShading' | 'doubleSided' | 'transparent',
) {
  return html`<label class="check">
    <input
      type="checkbox"
      checked=${() => !!node().material?.[key]}
      onChange=${(e: Event) =>
        mutate({
          type: 'setMaterial',
          id: node().id,
          patch: { [key]: (e.currentTarget as HTMLInputElement).checked } as Partial<MaterialDef>,
        })}
    />
    <span>${label}</span>
  </label>`;
}


export function Inspector() {
  const node = createMemo(() => selectedNode());
  const counts = createMemo(() => {
    doc();
    const id = selection();
    return id ? reconciler.meshCounts(id) : null;
  });

  const body = () => {
    const n = node();
    if (!n) return null;
    const get = () => selectedNode() ?? n;
    return html`
      <div class="insp-sec">
        <div class="row">
          <label>Name</label>
          <input
            class="txt"
            value=${() => get().name}
            onChange=${(e: Event) =>
              mutate({
                type: 'renameNode',
                id: get().id,
                name: (e.currentTarget as HTMLInputElement).value.trim() || get().name,
              })}
          />
        </div>
        <div class="row">
          <label>Visible</label>
          <label class="check">
            <input
              type="checkbox"
              checked=${() => get().visible}
              onChange=${(e: Event) =>
                mutate({
                  type: 'setVisible',
                  id: get().id,
                  visible: (e.currentTarget as HTMLInputElement).checked,
                })}
            />
            <span>${() => (get().visible ? 'shown' : 'hidden')}</span>
          </label>
        </div>
      </div>

      <div class="insp-sec">
        <div class="insp-h">Transform</div>
        ${vecRow('Position', get, 'p', 0.1)} ${vecRow('Rotation°', get, 'r', 5)}
        ${vecRow('Scale', get, 's', 0.1)}
      </div>

      <${Show} when=${() => get().kind === 'mesh'}>
        <div class="insp-sec">
          <div class="insp-h">Geometry</div>
          <div class="stat-grid">
            <span>type</span><b>${() => get().geometry?.type ?? '—'}</b>
            <span>verts</span><b>${() => (counts()?.verts ?? 0).toLocaleString()}</b>
            <span>tris</span><b>${() => (counts()?.tris ?? 0).toLocaleString()}</b>
          </div>
        </div>

        <div class="insp-sec">
          <div class="insp-h">Material</div>
          <div class="row">
            <label>Color</label>
            <input
              type="color"
              value=${() => get().material?.color ?? '#ffffff'}
              onInput=${(e: Event) =>
                mutate({
                  type: 'setMaterial',
                  id: get().id,
                  patch: { color: (e.currentTarget as HTMLInputElement).value },
                })}
            />
          </div>
          ${slider('Metalness', get, 'metalness')} ${slider('Roughness', get, 'roughness')}
          ${slider('Opacity', get, 'opacity')}
          <div class="checks" style="margin-top:6px">
            ${toggle('Wireframe', get, 'wireframe')} ${toggle('Flat shading', get, 'flatShading')}
            ${toggle('Double sided', get, 'doubleSided')} ${toggle('Transparent', get, 'transparent')}
          </div>
        </div>
      <//>
    `;
  };

  return html`<div
    class=${dock.cls}
    ref=${(el: HTMLDivElement) => dock.attach(el)}
    onMouseEnter=${dock.onEnter}
    onMouseLeave=${dock.onLeave}
  >
    <div class="rail" title=${railTitle('Inspector')}>
      <span class="rail-ico">⚙</span>
      <span class="rail-label">Inspector</span>
    </div>
    <div class="panel panel-right">
      <div class="panel-title">
        <span>Inspector</span>
        <span class="panel-title-r">
          <span>${() => node()?.kind ?? ''}</span>
          <button
            class=${() => (dock.pinned() ? 'pin pin-on' : 'pin')}
            onClick=${dock.togglePin}
            title=${() => (dock.pinned() ? 'Unpin — panel hides on mouse-out' : 'Pin panel open')}
          >
            ⌗
          </button>
        </span>
      </div>
      <div class="panel-body">
        <${Show}
          when=${() => !!node()}
          fallback=${() =>
            html`<div class="insp-empty">
              Select a node in the scene tree to inspect and edit it.
            </div>`}
        >
          ${body}
        <//>
        <${Show} when=${() => warnings().length > 0}>
          <div class="warn">
            <b>Import notes</b>
            <ul>
              ${() => warnings().map((w) => html`<li>${w}</li>`)}
            </ul>
          </div>
        <//>
      </div>
    </div>
  </div>`;
}
