import type { Deck } from './types';
import { appStorage } from '@bundled/yaar';

const STORAGE_PATH = 'draft.json';

export async function saveDeck(deck: Deck): Promise<void> {
  try { await appStorage.save(STORAGE_PATH, JSON.stringify(deck)); } catch { /* ignore */ }
}

export async function loadDeck(): Promise<Deck | null> {
  try {
    const text = await appStorage.read(STORAGE_PATH);
    return JSON.parse(text) as Deck;
  } catch { return null; }
}
