/// <reference lib="dom" />

import { effect } from './reactivity.ts';
import type { Signal } from './reactivity.ts';

// ── List Rendering ──────────────────────────────────────────────────────────

export function list<T>(
  container: HTMLElement,
  items$: Signal<T[]>,
  renderFn: (item: T, index: number) => HTMLElement,
  key?: (item: T) => string | number,
): () => void {
  const nodeMap = new Map<string | number, HTMLElement>();
  let prevKeys: (string | number)[] = [];

  return effect(() => {
    const items = items$();
    const newKeys = key ? items.map((item) => key(item)) : items.map((_item, idx) => idx);

    // Remove old nodes not in new keys
    const newKeySet = new Set(newKeys);
    for (const k of prevKeys) {
      if (!newKeySet.has(k)) {
        const node = nodeMap.get(k);
        if (node) {
          node.remove();
          nodeMap.delete(k);
        }
      }
    }

    // Create or reorder
    const frag = document.createDocumentFragment();
    const newNodes: HTMLElement[] = [];
    for (let i = 0; i < items.length; i++) {
      const k = newKeys[i];
      let node = nodeMap.get(k);
      if (!node) {
        node = renderFn(items[i], i);
        nodeMap.set(k, node);
      }
      newNodes.push(node);
    }

    // Batch DOM update
    for (const node of newNodes) frag.appendChild(node);
    container.replaceChildren(frag);

    prevKeys = newKeys;
  });
}
