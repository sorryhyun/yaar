import { normalizeAspectRatio } from './aspect-ratio';
import { isThemeId } from './theme';
import type { Deck, Slide, SlideLayout } from './types';
import { uuid } from './utils';

export function newSlide(layout: SlideLayout = 'title-body'): Slide {
  return { id: uuid(), layout, title: 'New Slide', body: '', imageUrl: '', notes: '' };
}

export function newDeck(): Deck {
  return {
    title: 'Untitled Deck',
    themeId: 'classic-light',
    slides: [newSlide()],
    activeIndex: 0,
    aspectRatio: '16:9',
  };
}

export function isSlideLayout(value: unknown): value is SlideLayout {
  return value === 'title-body' || value === 'title-image' || value === 'section';
}

export function normalizeSlideInput(raw: Partial<Slide> | null | undefined): Slide {
  const source = raw ?? {};
  return {
    id: source.id || uuid(),
    layout: isSlideLayout(source.layout) ? source.layout : 'title-body',
    title: source.title || '',
    body: source.body || '',
    imageUrl: source.imageUrl || '',
    notes: source.notes || '',
  };
}

export function normalizeDeck(raw: Deck): Deck {
  const slides = (raw.slides?.length ? raw.slides : [newSlide()]).map((s) => ({
    id: s.id || uuid(),
    layout: s.layout || 'title-body',
    title: s.title || '',
    body: s.body || '',
    imageUrl: s.imageUrl || '',
    notes: (s as Slide & { notes?: string }).notes || '',
  }));
  return {
    title: raw.title || 'Untitled Deck',
    themeId: isThemeId(raw.themeId) ? raw.themeId : 'classic-light',
    slides,
    activeIndex: Math.min(Math.max(raw.activeIndex ?? 0, 0), slides.length - 1),
    aspectRatio: normalizeAspectRatio(raw.aspectRatio),
  };
}
