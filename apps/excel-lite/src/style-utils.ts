import { DEFAULT_STYLE } from './constants';
import type { CellStyle, CellStyleMap } from './types';

/** Merge cell-specific style with defaults, returning a fully populated style object. */
export function getStyleForRef(styles: CellStyleMap, ref: string): Required<CellStyle> {
  return { ...DEFAULT_STYLE, ...styles[ref] } as Required<CellStyle>;
}

/**
 * Strip default-value properties from a style object.
 * Returns null when the resulting object is empty (i.e. fully default).
 */
export function normalizeStyle(style: CellStyle): CellStyle | null {
  const normalized: CellStyle = {};

  // Boolean properties — loop to avoid repetition
  const boolKeys = ['bold', 'italic', 'underline'] as const;
  for (const k of boolKeys) {
    if ((style[k] ?? DEFAULT_STYLE[k]) !== DEFAULT_STYLE[k]) {
      normalized[k] = !!style[k];
    }
  }

  if ((style.fontSize ?? DEFAULT_STYLE.fontSize) !== DEFAULT_STYLE.fontSize) normalized.fontSize = style.fontSize;
  if ((style.color    ?? DEFAULT_STYLE.color)    !== DEFAULT_STYLE.color)    normalized.color    = style.color;
  if ((style.bg       ?? DEFAULT_STYLE.bg)       !== DEFAULT_STYLE.bg)       normalized.bg       = style.bg;
  if ((style.align    ?? DEFAULT_STYLE.align)    !== DEFAULT_STYLE.align)    normalized.align    = style.align;

  return Object.keys(normalized).length ? normalized : null;
}
