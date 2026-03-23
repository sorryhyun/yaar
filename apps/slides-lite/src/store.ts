import { createSignal } from '@bundled/solid-js';
import { showToast } from '@bundled/yaar';
import { saveDeck } from './storage';
import { newDeck, normalizeDeck } from './deck-utils';
import { debounce } from './utils';
import type { Deck, Slide } from './types';

// deck state (mutable, shared via get/set)
let _deck = normalizeDeck(newDeck());
export function getDeck() { return _deck; }
export function setDeck(d: Deck) { _deck = d; }

// signals
export const [deckVer, setDeckVer] = createSignal(0);
export const [activeIndexVer, setActiveIndexVer] = createSignal(0);
export const [dirty, setDirty] = createSignal(false);
export const [lastSavedAt, setLastSavedAt] = createSignal(Date.now());

// misc mutable
export let filterQueryValue = '';
export function setFilterQueryValue(q: string) { filterQueryValue = q; }

// presenting state
export let presenting = false;
export function setPresenting(v: boolean) { presenting = v; }
export function isPresenting() { return presenting; }
export let presentIndex = 0;
export function setPresentIndex(v: number) { presentIndex = v; }
export let presentStartedAt = 0;
export function setPresentStartedAt(v: number) { presentStartedAt = v; }
export let presentTimerId: number | null = null;
export function setPresentTimerId(v: number | null) { presentTimerId = v; }

export function bumpDeck() { setDeckVer(deckVer() + 1); }
export function bumpActiveIndex() { setActiveIndexVer(activeIndexVer() + 1); }

export function clampActive() {
  const deck = _deck;
  if (deck.activeIndex < 0) deck.activeIndex = 0;
  if (deck.activeIndex > deck.slides.length - 1) deck.activeIndex = deck.slides.length - 1;
}

export function activeSlide(): Slide {
  clampActive();
  return _deck.slides[_deck.activeIndex];
}

const debouncedSave = debounce(() => {
  setDirty(false);
  setLastSavedAt(Date.now());
  void saveDeck(_deck);
}, 700);

export function markDirty() {
  setDirty(true);
  debouncedSave();
}

export function persist(withToast = false) {
  void saveDeck(_deck);
  setDirty(false);
  setLastSavedAt(Date.now());
  if (withToast) showToast('Saved', 'success');
}

export function moveSlide(from: number, to: number) {
  if (to < 0 || to >= _deck.slides.length || from === to) return;
  const [item] = _deck.slides.splice(from, 1);
  _deck.slides.splice(to, 0, item);
  _deck.activeIndex = to;
  markDirty();
  bumpDeck();
  bumpActiveIndex();
}
