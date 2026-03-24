import { createSignal } from '@bundled/solid-js';
import { appStorage } from '@bundled/yaar';
import { v4 as uuid } from '@bundled/uuid';
import type { Memo } from './types';

const STORAGE_KEY = 'memos.json';

export const [memos, setMemos] = createSignal<Memo[]>([]);
export const [selectedId, setSelectedId] = createSignal<string | null>(null);
export const [editMode, setEditMode] = createSignal<'none' | 'new' | 'edit'>('none');
export const [editTitle, setEditTitle] = createSignal('');
export const [editContent, setEditContent] = createSignal('');
export const [searchQuery, setSearchQuery] = createSignal('');

export async function loadMemos() {
  const data = await appStorage.readJsonOr<{ memos: Memo[] }>(STORAGE_KEY, { memos: [] });
  setMemos(data.memos);
}

async function saveMemos(list: Memo[]) {
  setMemos(list);
  await appStorage.save(STORAGE_KEY, JSON.stringify({ memos: list }));
}

export async function addMemo(title: string, content: string): Promise<Memo> {
  const now = new Date().toISOString();
  const memo: Memo = { id: uuid(), title: title.trim() || 'Untitled', content, createdAt: now, updatedAt: now };
  await saveMemos([memo, ...memos()]);
  return memo;
}

export async function updateMemo(id: string, title?: string, content?: string): Promise<Memo | null> {
  const list = memos().map(m => {
    if (m.id !== id) return m;
    return {
      ...m,
      title: title !== undefined ? (title.trim() || 'Untitled') : m.title,
      content: content !== undefined ? content : m.content,
      updatedAt: new Date().toISOString(),
    };
  });
  await saveMemos(list);
  return list.find(m => m.id === id) ?? null;
}

export async function deleteMemo(id: string): Promise<boolean> {
  const list = memos().filter(m => m.id !== id);
  if (list.length === memos().length) return false;
  await saveMemos(list);
  if (selectedId() === id) {
    setSelectedId(null);
    setEditMode('none');
  }
  return true;
}

export function searchMemos(query: string): Memo[] {
  const q = query.toLowerCase();
  return memos().filter(m =>
    m.title.toLowerCase().includes(q) || m.content.toLowerCase().includes(q)
  );
}

export function getFilteredMemos(): Memo[] {
  const q = searchQuery().trim();
  if (!q) return memos();
  return searchMemos(q);
}

export function getMemoById(id: string): Memo | undefined {
  return memos().find(m => m.id === id);
}
