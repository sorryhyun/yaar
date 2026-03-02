import type { Deck } from './types';

const STORAGE_PATH = 'slides-lite/draft.json';
const storage = (window as any).yaar?.storage;

export async function saveDeck(deck: Deck): Promise<void> {
  if (!storage) return;
  try { await storage.save(STORAGE_PATH, JSON.stringify(deck)); } catch { /* ignore */ }
}

export async function loadDeck(): Promise<Deck | null> {
  if (!storage) return null;
  try {
    const raw = await storage.read(STORAGE_PATH, { as: 'text' });
    return JSON.parse(raw) as Deck;
  } catch { return null; }
}
