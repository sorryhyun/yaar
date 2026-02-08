export type CellMap = Record<string, string>;
export type Align = 'left' | 'center' | 'right';

export type CellStyle = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  fontSize?: number;
  color?: string;
  bg?: string;
  align?: Align;
};

export type CellStyleMap = Record<string, CellStyle>;

export type Rect = { c1: number; c2: number; r1: number; r2: number };

export type Snapshot = { cells: CellMap; styles: CellStyleMap };
