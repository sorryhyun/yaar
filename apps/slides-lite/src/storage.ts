import type { Deck } from './types';
import { appStorage } from '@bundled/yaar';

const STORAGE_PATH = 'draft.json';

/** Persist the deck. Resolves false (after reporting) when the write fails. */
export async function saveDeck(deck: Deck): Promise<boolean> {
  return appStorage.trySave(STORAGE_PATH, JSON.stringify(deck), { label: 'deck' });
}

export async function loadDeck(): Promise<Deck | null> {
  return appStorage.readJsonOr<Deck | null>(STORAGE_PATH, null);
}
