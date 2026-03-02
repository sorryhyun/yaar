import { normalizeAspectRatio } from './aspect-ratio';
import { isThemeId } from './theme';
import type { Deck, FontSize, Slide, SlideLayout } from './types';
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
    fontSize: 'md',
  };
}

export function isSlideLayout(value: unknown): value is SlideLayout {
  return value === 'title-body' || value === 'title-image' || value === 'section';
}

export function isFontSize(value: unknown): value is FontSize {
  return value === 'sm' || value === 'md' || value === 'lg' || value === 'xl';
}

export function normalizeSlideInput(raw: Partial<Slide> | null | undefined): Slide {
  const source = raw ?? {};
  const slide: Slide = {
    id: source.id || uuid(),
    layout: isSlideLayout(source.layout) ? source.layout : 'title-body',
    title: source.title || '',
    body: source.body || '',
    imageUrl: source.imageUrl || '',
    notes: source.notes || '',
  };
  // Optional per-slide fontSize: only set if valid, undefined means inherit from deck
  if (isFontSize(source.fontSize)) {
    slide.fontSize = source.fontSize;
  }
  return slide;
}

export function normalizeDeck(raw: Partial<Deck> & Pick<Deck, 'slides'>): Deck {
  const slides = (raw.slides?.length ? raw.slides : [newSlide()]).map((s) =>
    normalizeSlideInput(s),
  );
  return {
    title: raw.title || 'Untitled Deck',
    themeId: isThemeId(raw.themeId) ? raw.themeId : 'classic-light',
    slides,
    activeIndex: Math.min(Math.max(raw.activeIndex ?? 0, 0), slides.length - 1),
    aspectRatio: normalizeAspectRatio(raw.aspectRatio),
    fontSize: isFontSize(raw.fontSize) ? raw.fontSize : 'md',
  };
}
