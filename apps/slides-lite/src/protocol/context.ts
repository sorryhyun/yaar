import { createProtocolContext } from '@bundled/yaar';
import type { Deck, Slide } from '../types';

// === Types used only in protocol ===
export type StorageReadMode = 'text' | 'json' | 'auto';
export type StorageMergeMode = 'replace' | 'append';

// === Context passed in from main.ts ===
export interface ProtocolContext {
  getDeck: () => Deck;
  setDeck: (d: Deck) => void;
  getFilterQuery: () => string;
  setFilterQuery: (q: string) => void;
  activeSlide: () => Slide;
  clampActive: () => void;
  persist: (showToast?: boolean) => void;
  bumpDeck: () => void;
  bumpActiveIndex: () => void;
}

// Descriptor maps live at module scope so the protocol extractor can read them
// statically, but their handlers need the context supplied at registration time.
// registerProtocol() installs it here before app.register() runs. The holder
// itself is the shared SDK one: it throws on a read before set, and on a second
// set with a different context.
export const { set: setProtocolContext, get: ctx } =
  createProtocolContext<ProtocolContext>('slides-lite');
