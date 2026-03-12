import type { Deck } from './types';

const STORAGE_PATH = 'draft.json';
const _yaar = (window as any).yaar;

async function storageSave(path: string, content: string): Promise<void> {
  const result = await _yaar.invoke(`yaar://apps/self/storage/${path}`, { action: 'write', content });
  if (result.isError) throw new Error(result.content[0]?.text);
}

async function storageRead(path: string, as: 'text' | 'json' = 'text'): Promise<any> {
  const result = await _yaar.read(`yaar://apps/self/storage/${path}`);
  if (result.isError) throw new Error(result.content[0]?.text);
  const text = result.content[0]?.text ?? '';
  return as === 'json' ? JSON.parse(text) : text;
}

export async function saveDeck(deck: Deck): Promise<void> {
  if (!_yaar) return;
  try { await storageSave(STORAGE_PATH, JSON.stringify(deck)); } catch { /* ignore */ }
}

export async function loadDeck(): Promise<Deck | null> {
  if (!_yaar) return null;
  try {
    const raw = await storageRead(STORAGE_PATH, 'text');
    return JSON.parse(raw) as Deck;
  } catch { return null; }
}
