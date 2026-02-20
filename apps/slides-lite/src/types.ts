export type SlideLayout = 'title-body' | 'title-image' | 'section';

export type ThemeId = 'classic-light' | 'midnight-dark' | 'ocean' | 'sunset';

export interface Slide {
  id: string;
  layout: SlideLayout;
  title: string;
  body: string;
  imageUrl: string;
  notes: string;
}

export interface Deck {
  title: string;
  themeId: ThemeId;
  slides: Slide[];
  activeIndex: number;
  aspectRatio: string;
}
