import { createSignal } from '@bundled/solid-js';

/**
 * Cross-cell editor bookkeeping, shared by CellRow and CellEditor.
 *
 * `editors` maps cell id -> its textarea so Shift+Enter can advance focus to the
 * next cell, and so a markdown cell switched into edit mode can be focused once
 * its textarea exists. Entries are never removed: a deleted cell's id is never
 * looked up again, and the map is per-document.
 */
export const editors = new Map<string, HTMLTextAreaElement>();

const [editingMd, setEditingMd] = createSignal<string[]>([]);

export const isEditing = (id: string) => editingMd().includes(id);
export const startEdit = (id: string) => setEditingMd([...editingMd(), id]);
export const stopEdit = (id: string) => setEditingMd(editingMd().filter((x) => x !== id));

export function autosize(el: HTMLTextAreaElement): void {
  el.style.height = 'auto';
  el.style.height = Math.max(38, Math.min(700, el.scrollHeight + 2)) + 'px';
}
