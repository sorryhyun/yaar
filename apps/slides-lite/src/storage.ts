import type { Deck } from './types';

const KEY = 'slides-lite:draft';

export function saveDeck(deck: Deck): void {
  localStorage.setItem(KEY, JSON.stringify(deck));
}

export function loadDeck(): Deck | null {
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Deck;
  } catch {
    return null;
  }
}
