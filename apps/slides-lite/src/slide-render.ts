import { renderBodyContent, escapeHtml } from './markdown';
import { THEMES } from './theme';
import type { FontSize, Slide, ThemeId } from './types';

// Maps named font size to a CSS scale multiplier applied as --slide-fs-scale.
const FONT_SIZE_SCALE: Record<FontSize, number> = {
  sm: 0.78,
  md: 1.0,
  lg: 1.22,
  xl: 1.5,
};

export function renderSlideHtml(slide: Slide, themeId: ThemeId, fontSize: FontSize = 'md'): string {
  const t = THEMES[themeId];
  const effectiveFontSize: FontSize = slide.fontSize ?? fontSize;
  const scale = FONT_SIZE_SCALE[effectiveFontSize] ?? 1.0;

  // All layout variants share the same outer wrapper and base style.
  const style = `--slide-fs-scale:${scale};background:${t.bg};color:${t.fg};border-top:10px solid ${t.accent};`;
  const isSection = slide.layout === 'section';
  const cls = `slide${isSection ? ' section' : ''}`;
  const title = escapeHtml(slide.title || (isSection ? 'Section' : 'Title'));
  const body = `<div class="slide-body">${renderBodyContent(slide.body || '')}</div>`;

  // Middle content varies by layout.
  let middle = '';
  if (slide.layout === 'title-image') {
    middle = slide.imageUrl
      ? `<img src="${slide.imageUrl}" style="max-width:100%; max-height:260px; border-radius:12px; margin-top:12px; box-shadow:0 8px 20px rgba(0,0,0,.15);"/>`
      : '<div style="opacity:.65; padding:8px 0;">No image selected</div>';
  }

  return `<div class="${cls}" style="${style}"><h1>${title}</h1>${middle}${body}</div>`;
}
