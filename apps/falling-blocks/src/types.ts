export type PieceType = 'I' | 'J' | 'L' | 'O' | 'S' | 'T' | 'Z';
export type Matrix = number[][];

export interface Piece {
  type: PieceType;
  m: Matrix;
  x: number;
  y: number;
}

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  alpha: number;
  size: number;
  life: number;
  maxLife: number;
}

export interface FlashLine {
  row: number;
  alpha: number;
}
