/**
 * SceneTree.ts — flat-rendered hierarchy with select / rename / visibility.
 *
 * Rows are rendered from a flattened list and interactions are delegated on the
 * container, so no event handler is ever passed as a component prop (Solid's
 * `html` wraps props in reactive getters, which would fire them during render).
 */
import html from '@bundled/solid-js/html';
import { For, Show, createMemo, createSignal } from '@bundled/solid-js';
import { showPrompt } from '@bundled/yaar';
import { doc, mutate, select, selection } from '../store';
import { createDock, railTitle } from './dock';
import type { SceneNode } from '../scene-doc';

interface Row {
  node: SceneNode;
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
}

const [collapsed, setCollapsed] = createSignal<string[]>([]);

function toggleCollapse(id: string): void {
  setCollapsed((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
}

const rows = createMemo<Row[]>(() => {
  const out: Row[] = [];
  const hidden = collapsed();
  const walk = (nodes: SceneNode[], depth: number) => {
    for (const node of nodes) {
      const hasChildren = node.children.length > 0;
      const isShut = hidden.includes(node.id);
      out.push({ node, depth, hasChildren, collapsed: isShut });
      if (hasChildren && !isShut) walk(node.children, depth + 1);
    }
  };
  walk(doc().root.children, 0);
  return out;
});

async function rename(node: SceneNode): Promise<void> {
  const next = await showPrompt('Rename node', { title: node.name, initial: node.name });
  if (next && next.trim() && next !== node.name) {
    mutate({ type: 'renameNode', id: node.id, name: next.trim() });
  }
}

function onTreeClick(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  const row = target.closest('[data-node-id]') as HTMLElement | null;
  if (!row) return;
  const id = row.dataset.nodeId as string;
  const action = target.dataset.act;
  if (action === 'twist') {
    toggleCollapse(id);
    return;
  }
  if (action === 'eye') {
    const rowsNow = rows();
    const found = rowsNow.find((r) => r.node.id === id);
    if (found) mutate({ type: 'setVisible', id, visible: !found.node.visible });
    return;
  }
  select(id);
}

function onTreeDblClick(e: MouseEvent): void {
  const row = (e.target as HTMLElement).closest('[data-node-id]') as HTMLElement | null;
  if (!row) return;
  const found = rows().find((r) => r.node.id === row.dataset.nodeId);
  if (found) void rename(found.node);
}

const dock = createDock('left');

export function SceneTree() {
  return html`<div
    class=${dock.cls}
    ref=${(el: HTMLDivElement) => dock.attach(el)}
    onMouseEnter=${dock.onEnter}
    onMouseLeave=${dock.onLeave}
  >
    <div class="rail" title=${railTitle('Scene tree')}>
      <span class="rail-ico">☰</span>
      <span class="rail-label">Scene</span>
      <span class="rail-count">${() => rows().length}</span>
    </div>
    <div class="panel panel-left">
      <div class="panel-title">
        <span>Scene</span>
        <span class="panel-title-r">
          <span>${() => rows().length}</span>
          <button
            class=${() => (dock.pinned() ? 'pin pin-on' : 'pin')}
            onClick=${dock.togglePin}
            title=${() => (dock.pinned() ? 'Unpin — panel hides on mouse-out' : 'Pin panel open')}
          >
            ⌗
          </button>
        </span>
      </div>
      <div class="panel-body" onClick=${onTreeClick} onDblClick=${onTreeDblClick}>
        <${Show} when=${() => rows().length === 0}>
          <div class="insp-empty">Nothing loaded.</div>
        <//>
        <${For} each=${() => rows()}>
          ${(row: Row) => html`<div
            data-node-id=${row.node.id}
            class=${() =>
              [
                'tree-row',
                selection() === row.node.id ? 'sel' : '',
                row.node.visible ? '' : 'hidden-node',
              ]
                .filter(Boolean)
                .join(' ')}
            style=${`padding-left:${4 + row.depth * 12}px`}
            title=${row.node.name}
          >
            <span class="tree-twist" data-act=${row.hasChildren ? 'twist' : ''}>
              ${row.hasChildren ? (row.collapsed ? '▶' : '▼') : ''}
            </span>
            <span class="tree-name">${row.node.name}</span>
            <span class="tree-kind">${row.node.kind === 'mesh' ? 'M' : 'G'}</span>
            <span class="tree-eye" data-act="eye" title="Toggle visibility"
              >${() => (row.node.visible ? '👁' : '―')}</span
            >
          </div>`}
        <//>
      </div>
    </div>
  </div>`;
}