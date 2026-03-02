export type SlideLayout = 'title-body' | 'title-image' | 'section';

export type ThemeId = 'classic-light' | 'midnight-dark' | 'ocean' | 'sunset';

export type FontSize = 'sm' | 'md' | 'lg' | 'xl';

export interface Slide {
  id: string;
  layout: SlideLayout;
  title: string;
  body: string;
  imageUrl: string;
  notes: string;
  fontSize?: FontSize;
}

export interface Deck {
  title: string;
  themeId: ThemeId;
  slides: Slide[];
  activeIndex: number;
  aspectRatio: string;
  fontSize: FontSize;
}
