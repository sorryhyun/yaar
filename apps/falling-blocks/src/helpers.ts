import type { Matrix, Piece, PieceType, Particle } from './types';

export const COLS = 10;
export const ROWS = 20;
export const N = 4;

export const COLORS = [
  '#000000',
  '#00D7FF', // I - cyan
  '#2F6BFF', // J - blue
  '#FF9E2C', // L - orange
  '#FFE04A', // O - yellow
  '#58E05E', // S - green
  '#B35CFF', // T - purple
  '#FF4C68', // Z - red
];

export const GLOW_COLORS = [
  'rgba(0,0,0,0)',
  'rgba(0,215,255,0.7)',
  'rgba(47,107,255,0.7)',
  'rgba(255,158,44,0.7)',
  'rgba(255,224,74,0.7)',
  'rgba(88,224,94,0.7)',
  'rgba(179,92,255,0.7)',
  'rgba(255,76,104,0.7)',
];

export const SHAPES: Record<PieceType, Matrix> = {
  I: [
    [0, 0, 0, 0],
    [1, 1, 1, 1],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ],
  J: [
    [2, 0, 0, 0],
    [2, 2, 2, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ],
  L: [
    [0, 0, 3, 0],
    [3, 3, 3, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ],
  O: [
    [0, 4, 4, 0],
    [0, 4, 4, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ],
  S: [
    [0, 5, 5, 0],
    [5, 5, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ],
  T: [
    [0, 6, 0, 0],
    [6, 6, 6, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ],
  Z: [
    [7, 7, 0, 0],
    [0, 7, 7, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ],
};

export function cloneMatrix(m: Matrix): Matrix {
  return m.map((row) => row.slice());
}

export function rotateCW(m: Matrix): Matrix {
  const res: Matrix = Array.from({ length: N }, () => Array(N).fill(0));
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      res[x][N - 1 - y] = m[y][x];
    }
  }
  return res;
}

export function makeBoard(): number[][] {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(0));
}

export function collides(board: number[][], piece: Piece, dx = 0, dy = 0, testM?: Matrix): boolean {
  const m = testM ?? piece.m;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const v = m[y][x];
      if (!v) continue;
      const bx = piece.x + x + dx;
      const by = piece.y + y + dy;
      if (bx < 0 || bx >= COLS) return true;
      if (by >= ROWS) return true;
      if (by >= 0 && board[by][bx]) return true;
    }
  }
  return false;
}

export function merge(board: number[][], piece: Piece): void {
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const v = piece.m[y][x];
      if (!v) continue;
      const bx = piece.x + x;
      const by = piece.y + y;
      if (by >= 0 && by < ROWS && bx >= 0 && bx < COLS) {
        board[by][bx] = v;
      }
    }
  }
}

export function clearLines(board: number[][]): number[] {
  const cleared: number[] = [];
  for (let y = ROWS - 1; y >= 0; y--) {
    if (board[y].every((v) => v !== 0)) {
      cleared.push(y);
      board.splice(y, 1);
      board.unshift(Array(COLS).fill(0));
      y++;
    }
  }
  return cleared;
}

export function computeDropInterval(level: number): number {
  return Math.max(80, 800 - level * 65);
}

export function pointsForLines(lines: number, level: number, combo: number): number {
  const base = [0, 100, 300, 500, 800][lines] ?? lines * 200;
  const comboBonus = combo > 1 ? combo * 50 : 0;
  return (base + comboBonus) * (level + 1);
}

export function ghostY(board: number[][], piece: Piece): number {
  let y = piece.y;
  while (!collides(board, piece, 0, y - piece.y + 1)) {
    y++;
  }
  return y;
}

const TYPES: PieceType[] = ['I', 'J', 'L', 'O', 'S', 'T', 'Z'];
let bag: PieceType[] = [];
export function nextType(): PieceType {
  if (bag.length === 0) {
    bag = TYPES.slice();
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
  }
  return bag.pop()!;
}

export function resetBag(): void { bag = []; }

export function spawn(type: PieceType): Piece {
  return { type, m: cloneMatrix(SHAPES[type]), x: Math.floor(COLS / 2) - 2, y: -1 };
}

export function spawnParticles(row: number, blockSize: number, color: string, count = 12): Particle[] {
  const particles: Particle[] = [];
  for (let i = 0; i < count; i++) {
    const cx = (Math.random() * COLS) * blockSize;
    const cy = row * blockSize + blockSize / 2;
    const angle = Math.random() * Math.PI * 2;
    const speed = 1 + Math.random() * 4;
    particles.push({
      x: cx, y: cy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 2,
      color,
      alpha: 1,
      size: 2 + Math.random() * 4,
      life: 1,
      maxLife: 1,
    });
  }
  return particles;
}
