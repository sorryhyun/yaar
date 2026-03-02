import { renderBodyContent, escapeHtml } from './markdown';
import { THEMES } from './theme';
import type { FontSize, Slide, ThemeId } from './types';

// Maps named font size to a CSS scale multiplier applied as --slide-fs-scale.
// The base slide body font is clamp(14px, 1.7vw, 26px); the h1 scales similarly.
// We expose the scale so both values grow/shrink proportionally.
const FONT_SIZE_SCALE: Record<FontSize, number> = {
  sm: 0.78,
  md: 1.0,
  lg: 1.22,
  xl: 1.5,
};

export function renderSlideHtml(slide: Slide, themeId: ThemeId, fontSize: FontSize = 'md'): string {
  const t = THEMES[themeId];
  // Slide-level fontSize overrides deck-level fontSize
  const effectiveFontSize: FontSize = slide.fontSize ?? fontSize;
  const scale = FONT_SIZE_SCALE[effectiveFontSize] ?? 1.0;
  const fsStyle = `--slide-fs-scale:${scale};`;

  const image = slide.imageUrl
    ? `<img src="${slide.imageUrl}" style="max-width:100%; max-height:260px; border-radius:12px; margin-top:12px; box-shadow:0 8px 20px rgba(0,0,0,.15);"/>`
    : '';

  if (slide.layout === 'section') {
    return `<div class="slide section" style="${fsStyle}background:${t.bg};color:${t.fg};border-top:10px solid ${t.accent};">
      <h1>${escapeHtml(slide.title || 'Section')}</h1>
      <div class="slide-body">${renderBodyContent(slide.body || '')}</div>
    </div>`;
  }

  if (slide.layout === 'title-image') {
    return `<div class="slide" style="${fsStyle}background:${t.bg};color:${t.fg};border-top:10px solid ${t.accent};">
      <h1>${escapeHtml(slide.title || 'Title')}</h1>
      ${image || '<div style="opacity:.65; padding:8px 0;">No image selected</div>'}
      <div class="slide-body">${renderBodyContent(slide.body || '')}</div>
    </div>`;
  }

  return `<div class="slide" style="${fsStyle}background:${t.bg};color:${t.fg};border-top:10px solid ${t.accent};">
    <h1>${escapeHtml(slide.title || 'Title')}</h1>
    <div class="slide-body">${renderBodyContent(slide.body || '')}</div>
  </div>`;
}
