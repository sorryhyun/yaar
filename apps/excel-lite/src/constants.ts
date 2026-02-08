import type { CellStyle } from './types';

export const ROWS = 60;
export const COLS = 20;

export const DEFAULT_STYLE: Required<CellStyle> = {
  bold: false,
  italic: false,
  underline: false,
  fontSize: 14,
  color: '#111827',
  bg: '#ffffff',
  align: 'left'
};
