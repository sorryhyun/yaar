import { DEFAULT_STYLE } from './constants';
import type { CellStyle, CellStyleMap } from './types';

export function getStyleForRef(styles: CellStyleMap, ref: string): Required<CellStyle> {
  const s = styles[ref] ?? {};
  return {
    bold: s.bold ?? DEFAULT_STYLE.bold,
    italic: s.italic ?? DEFAULT_STYLE.italic,
    underline: s.underline ?? DEFAULT_STYLE.underline,
    fontSize: s.fontSize ?? DEFAULT_STYLE.fontSize,
    color: s.color ?? DEFAULT_STYLE.color,
    bg: s.bg ?? DEFAULT_STYLE.bg,
    align: s.align ?? DEFAULT_STYLE.align
  };
}

export function normalizeStyle(style: CellStyle): CellStyle | null {
  const normalized: CellStyle = {};
  if ((style.bold ?? DEFAULT_STYLE.bold) !== DEFAULT_STYLE.bold) normalized.bold = !!style.bold;
  if ((style.italic ?? DEFAULT_STYLE.italic) !== DEFAULT_STYLE.italic) normalized.italic = !!style.italic;
  if ((style.underline ?? DEFAULT_STYLE.underline) !== DEFAULT_STYLE.underline) normalized.underline = !!style.underline;
  if ((style.fontSize ?? DEFAULT_STYLE.fontSize) !== DEFAULT_STYLE.fontSize) normalized.fontSize = style.fontSize;
  if ((style.color ?? DEFAULT_STYLE.color) !== DEFAULT_STYLE.color) normalized.color = style.color;
  if ((style.bg ?? DEFAULT_STYLE.bg) !== DEFAULT_STYLE.bg) normalized.bg = style.bg;
  if ((style.align ?? DEFAULT_STYLE.align) !== DEFAULT_STYLE.align) normalized.align = style.align;
  return Object.keys(normalized).length ? normalized : null;
}
