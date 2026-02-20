import { renderBodyContent, escapeHtml } from './markdown';
import { THEMES } from './theme';
import type { Slide, ThemeId } from './types';

export function renderSlideHtml(slide: Slide, themeId: ThemeId): string {
  const t = THEMES[themeId];
  const image = slide.imageUrl
    ? `<img src="${slide.imageUrl}" style="max-width:100%; max-height:260px; border-radius:12px; margin-top:12px; box-shadow:0 8px 20px rgba(0,0,0,.15);"/>`
    : '';

  if (slide.layout === 'section') {
    return `<div class="slide section" style="background:${t.bg};color:${t.fg};border-top:10px solid ${t.accent};">
      <h1>${escapeHtml(slide.title || 'Section')}</h1>
      <div class="slide-body">${renderBodyContent(slide.body || '')}</div>
    </div>`;
  }

  if (slide.layout === 'title-image') {
    return `<div class="slide" style="background:${t.bg};color:${t.fg};border-top:10px solid ${t.accent};">
      <h1>${escapeHtml(slide.title || 'Title')}</h1>
      ${image || '<div style="opacity:.65; padding:8px 0;">No image selected</div>'}
      <div class="slide-body">${renderBodyContent(slide.body || '')}</div>
    </div>`;
  }

  return `<div class="slide" style="background:${t.bg};color:${t.fg};border-top:10px solid ${t.accent};">
    <h1>${escapeHtml(slide.title || 'Title')}</h1>
    <div class="slide-body">${renderBodyContent(slide.body || '')}</div>
  </div>`;
}
