import { normalizeAspectRatio } from './aspect-ratio';
import { isThemeId } from './theme';
import type { Deck, FontSize, Slide, SlideLayout } from './types';
import { uuid } from './utils';

// Single source of truth for valid enum values — consumed by isSlideLayout,
// isFontSize, and UI select lists to avoid repeating literal arrays.
export const SLIDE_LAYOUTS: SlideLayout[] = ['title-body', 'title-image', 'section'];
export const FONT_SIZES: FontSize[] = ['sm', 'md', 'lg', 'xl'];

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
  return SLIDE_LAYOUTS.includes(value as SlideLayout);
}

export function isFontSize(value: unknown): value is FontSize {
  return FONT_SIZES.includes(value as FontSize);
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
