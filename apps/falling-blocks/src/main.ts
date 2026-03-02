import { signal, html, mount, show } from '@bundled/yaar';
import './styles.css';

// --- Types and constants ---

type PieceType = 'I' | 'J' | 'L' | 'O' | 'S' | 'T' | 'Z';

type Matrix = number[][];

const COLS = 10;
const ROWS = 20;
const N = 4; // tetromino matrix size

const COLORS = [
  '#000000',
  '#00D7FF', // I
  '#2F6BFF', // J
  '#FF9E2C', // L
  '#FFE04A', // O
  '#58E05E', // S
  '#B35CFF', // T
  '#FF4C68', // Z
];

const SHAPES: Record<PieceType, Matrix> = {
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

interface Piece {
  type: PieceType;
  m: Matrix;
  x: number;
  y: number;
}

function cloneMatrix(m: Matrix): Matrix {
  return m.map((row) => row.slice());
}

function rotateCW(m: Matrix): Matrix {
  const res: Matrix = Array.from({ length: N }, () => Array(N).fill(0));
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      res[x][N - 1 - y] = m[y][x];
    }
  }
  return res;
}

function makeBoard(): number[][] {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(0));
}

const TYPES: PieceType[] = ['I', 'J', 'L', 'O', 'S', 'T', 'Z'];
let bag: PieceType[] = [];
function nextType(): PieceType {
  if (bag.length === 0) {
    bag = TYPES.slice();
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
  }
  return bag.pop()!;
}

function spawn(type: PieceType): Piece {
  return {
    type,
    m: cloneMatrix(SHAPES[type]),
    x: Math.floor(COLS / 2) - 2,
    y: -1,
  };
}

function collides(board: number[][], piece: Piece, dx = 0, dy = 0, testM?: Matrix): boolean {
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

function merge(board: number[][], piece: Piece): void {
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

function clearLines(board: number[][]): number {
  let cleared = 0;
  for (let y = ROWS - 1; y >= 0; y--) {
    if (board[y].every((v) => v !== 0)) {
      board.splice(y, 1);
      board.unshift(Array(COLS).fill(0));
      cleared++;
      y++; // re-check this row index after shifting
    }
  }
  return cleared;
}

function computeDropInterval(level: number): number {
  // simple (fast enough) ramp
  return Math.max(90, 800 - level * 60);
}

function pointsForLines(lines: number, level: number): number {
  const base = [0, 100, 300, 500, 800][lines] ?? (lines * 200);
  return base * (level + 1);
}

// --- Display signals ---

const scoreS = signal(0);
const hiS = signal(0);
const linesS = signal(0);
const levelS = signal(0);
const pausedS = signal(false);
const gameOverS = signal(false);

// --- Canvas refs (set synchronously via ref callbacks in html template) ---

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let nextCanvas!: HTMLCanvasElement;
let nextCtx!: CanvasRenderingContext2D;
let holdCanvas!: HTMLCanvasElement;
let holdCtx!: CanvasRenderingContext2D;

// --- Mutable game state ---

let board = makeBoard();
let current = spawn(nextType());
let next = spawn(nextType());
let hold: PieceType | null = null;
let canHold = true;

let score = 0;
let lines = 0;
let level = 0;
let dropInterval = computeDropInterval(level);
let dropAccum = 0;
let lastTime = 0;
let paused = false;
let gameOver = false;
let hi = 0;

// --- Persistence ---

async function saveHi(): Promise<void> {
  const storage = (window as any).yaar?.storage;
  if (storage) {
    try { await storage.save('falling-blocks/hi.json', JSON.stringify({ hi })); } catch { /* ignore */ }
  }
}

async function loadHi(): Promise<void> {
  const storage = (window as any).yaar?.storage;
  if (storage) {
    try {
      const saved = await storage.read('falling-blocks/hi.json', { as: 'json' });
      if (saved && typeof saved.hi === 'number') { hi = saved.hi; hiS(hi); }
    } catch { /* no save yet */ }
  }
}

// --- State update helpers ---

function updateStats(): void {
  scoreS(score); hiS(hi); linesS(lines); levelS(level);
}

function updateOverlay(): void {
  gameOverS(gameOver); pausedS(paused);
}

function updateHi(): void {
  if (score > hi) {
    hi = score;
    hiS(hi);
    void saveHi();
  }
}

// --- Game logic ---

function reset(): void {
  board = makeBoard();
  bag = [];
  current = spawn(nextType());
  next = spawn(nextType());
  hold = null;
  canHold = true;
  score = 0;
  lines = 0;
  level = 0;
  dropInterval = computeDropInterval(level);
  dropAccum = 0;
  paused = false;
  gameOver = false;
  updateStats();
  updateOverlay();
}

function tryMove(dx: number, dy: number): boolean {
  if (!collides(board, current, dx, dy)) {
    current.x += dx;
    current.y += dy;
    return true;
  }
  return false;
}

function lockAndAdvance(): void {
  merge(board, current);
  const cleared = clearLines(board);
  if (cleared) {
    lines += cleared;
    score += pointsForLines(cleared, level);
    const newLevel = Math.floor(lines / 10);
    if (newLevel !== level) {
      level = newLevel;
      dropInterval = computeDropInterval(level);
    }
  }

  updateHi();

  current = next;
  current.x = Math.floor(COLS / 2) - 2;
  current.y = -1;
  next = spawn(nextType());
  canHold = true;

  if (collides(board, current, 0, 0)) {
    gameOver = true;
  }
  updateStats();
  updateOverlay();
}

function softDrop(): void {
  if (!tryMove(0, 1)) {
    lockAndAdvance();
  } else {
    score += 1;
    updateHi();
    updateStats();
  }
}

function hardDrop(): void {
  if (gameOver || paused) return;
  let dropped = 0;
  while (!collides(board, current, 0, 1)) {
    current.y++;
    dropped++;
  }
  score += dropped * 2;
  updateHi();
  lockAndAdvance();
}

function holdPiece(): void {
  if (!canHold || gameOver || paused) return;
  canHold = false;
  const curType = current.type;
  if (hold == null) {
    hold = curType;
    current = next;
    current.x = Math.floor(COLS / 2) - 2;
    current.y = -1;
    next = spawn(nextType());
  } else {
    current = spawn(hold);
    hold = curType;
  }
  if (collides(board, current, 0, 0)) {
    gameOver = true;
    updateOverlay();
  }
}

function rotateCurrent(): void {
  if (gameOver || paused) return;
  const rotated = rotateCW(current.m);
  const kicks = [0, -1, 1, -2, 2];
  for (const k of kicks) {
    if (!collides(board, current, k, 0, rotated)) {
      current.m = rotated;
      current.x += k;
      return;
    }
  }
}

function togglePause(): void {
  if (gameOver) return;
  paused = !paused;
  updateOverlay();
}

// --- Rendering ---

let BLOCK = 26;

function fit(): void {
  const maxH = Math.min(760, window.innerHeight - 120);
  BLOCK = Math.max(18, Math.floor(maxH / ROWS));
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${COLS * BLOCK}px`;
  canvas.style.height = `${ROWS * BLOCK}px`;
  canvas.width = Math.floor(COLS * BLOCK * dpr);
  canvas.height = Math.floor(ROWS * BLOCK * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const miniSize = Math.floor(BLOCK * 0.9);
  for (const c of [nextCanvas, holdCanvas]) {
    c.style.width = `${miniSize * 4}px`;
    c.style.height = `${miniSize * 4}px`;
    c.width = Math.floor(miniSize * 4 * dpr);
    c.height = Math.floor(miniSize * 4 * dpr);
  }
  nextCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  holdCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawCell(g: CanvasRenderingContext2D, x: number, y: number, v: number, alpha = 1): void {
  if (!v) return;
  g.save();
  g.globalAlpha = alpha;
  g.fillStyle = COLORS[v];
  g.fillRect(x * BLOCK, y * BLOCK, BLOCK, BLOCK);
  g.strokeStyle = 'rgba(0,0,0,0.35)';
  g.lineWidth = 1;
  g.strokeRect(x * BLOCK + 0.5, y * BLOCK + 0.5, BLOCK - 1, BLOCK - 1);
  g.restore();
}

function drawMatrix(g: CanvasRenderingContext2D, m: Matrix, ox: number, oy: number, alpha = 1): void {
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const v = m[y][x];
      if (!v) continue;
      drawCell(g, ox + x, oy + y, v, alpha);
    }
  }
}

function ghostY(): number {
  let y = current.y;
  while (!collides(board, current, 0, y - current.y + 1)) {
    y++;
  }
  return y;
}

function clearCanvas(g: CanvasRenderingContext2D, w: number, h: number): void {
  g.clearRect(0, 0, w, h);
  g.fillStyle = 'rgba(0,0,0,0.28)';
  g.fillRect(0, 0, w, h);
}

function render(): void {
  clearCanvas(ctx, COLS * BLOCK, ROWS * BLOCK);

  // subtle grid
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  for (let x = 1; x < COLS; x++) {
    ctx.beginPath();
    ctx.moveTo(x * BLOCK + 0.5, 0);
    ctx.lineTo(x * BLOCK + 0.5, ROWS * BLOCK);
    ctx.stroke();
  }
  for (let y = 1; y < ROWS; y++) {
    ctx.beginPath();
    ctx.moveTo(0, y * BLOCK + 0.5);
    ctx.lineTo(COLS * BLOCK, y * BLOCK + 0.5);
    ctx.stroke();
  }
  ctx.restore();

  // board
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const v = board[y][x];
      if (v) drawCell(ctx, x, y, v, 1);
    }
  }

  // ghost
  if (!gameOver) {
    const gy = ghostY();
    drawMatrix(ctx, current.m, current.x, gy, 0.22);
  }

  // current piece
  drawMatrix(ctx, current.m, current.x, current.y, 1);

  // minis
  const miniSize = Math.floor(BLOCK * 0.9);
  const dpr = window.devicePixelRatio || 1;

  // Next
  nextCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  nextCtx.clearRect(0, 0, miniSize * 4, miniSize * 4);
  nextCtx.fillStyle = 'rgba(0,0,0,0.28)';
  nextCtx.fillRect(0, 0, miniSize * 4, miniSize * 4);
  nextCtx.save();
  nextCtx.scale(miniSize / BLOCK, miniSize / BLOCK);
  drawMatrix(nextCtx, next.m, 0, 0, 1);
  nextCtx.restore();

  // Hold
  holdCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  holdCtx.clearRect(0, 0, miniSize * 4, miniSize * 4);
  holdCtx.fillStyle = 'rgba(0,0,0,0.28)';
  holdCtx.fillRect(0, 0, miniSize * 4, miniSize * 4);
  if (hold) {
    const hp = spawn(hold);
    holdCtx.save();
    holdCtx.scale(miniSize / BLOCK, miniSize / BLOCK);
    drawMatrix(holdCtx, hp.m, 0, 0, canHold ? 1 : 0.6);
    holdCtx.restore();
  }
}

// --- Game loop ---

function step(time: number): void {
  const dt = time - lastTime;
  lastTime = time;

  if (!paused && !gameOver) {
    dropAccum += dt;
    if (dropAccum >= dropInterval) {
      dropAccum = 0;
      if (!tryMove(0, 1)) {
        lockAndAdvance();
      }
    }
  }

  render();
  requestAnimationFrame(step);
}

// --- Input ---

window.addEventListener('keydown', (e) => {
  const key = e.key;
  if (['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', ' '].includes(key)) e.preventDefault();

  if (key === 'r' || key === 'R') {
    reset();
    return;
  }
  if (key === 'p' || key === 'P') {
    togglePause();
    return;
  }

  if (paused || gameOver) return;

  if (key === 'ArrowLeft') {
    tryMove(-1, 0);
  } else if (key === 'ArrowRight') {
    tryMove(1, 0);
  } else if (key === 'ArrowDown') {
    softDrop();
  } else if (key === 'ArrowUp') {
    rotateCurrent();
  } else if (key === ' ') {
    hardDrop();
  } else if (key === 'c' || key === 'C') {
    holdPiece();
  }
});

window.addEventListener('resize', () => {
  fit();
});

// --- Mount reactive UI ---

mount(html`
  <div id="app">
    <div style="position:relative">
      <canvas ref=${(el: HTMLCanvasElement) => { canvas = el; ctx = el.getContext('2d')!; }} />
      ${show(
        () => gameOverS() || pausedS(),
        () => html`
          <div class="overlay">
            <div class="overlayBox">
              ${() => gameOverS()
                ? html`<h2>Game Over</h2><p>Press R to restart.</p>`
                : html`<h2>Paused</h2><p>Press P to resume.</p>`
              }
            </div>
          </div>
        `
      )}
    </div>
    <div class="panel">
      <div class="title y-text-sm y-font-mono">Falling Blocks</div>
      <div class="card">
        <div class="stat y-text-sm y-font-mono"><span>Score</span><b>${() => scoreS()}</b></div>
        <div class="stat y-text-sm y-font-mono"><span>High</span><b>${() => hiS()}</b></div>
        <div class="stat y-text-sm y-font-mono"><span>Lines</span><b>${() => linesS()}</b></div>
        <div class="stat y-text-sm y-font-mono"><span>Level</span><b>${() => levelS()}</b></div>
      </div>
      <div class="card">
        <div class="miniWrap">
          <div class="miniCol">
            <div class="miniLabel">Next</div>
            <canvas ref=${(el: HTMLCanvasElement) => { nextCanvas = el; nextCtx = el.getContext('2d')!; }} />
          </div>
          <div class="miniCol">
            <div class="miniLabel">Hold</div>
            <canvas ref=${(el: HTMLCanvasElement) => { holdCanvas = el; holdCtx = el.getContext('2d')!; }} />
          </div>
        </div>
      </div>
      <div class="card">
        <div class="btnRow">
          <button class="y-btn y-btn-sm" onClick=${() => reset()}>Restart (R)</button>
          <button class="y-btn y-btn-sm" onClick=${() => togglePause()}>Pause (P)</button>
        </div>
      </div>
      <div class="help y-text-xs y-text-muted">←/→ move • ↑ rotate • ↓ soft drop • Space hard drop • C hold • P pause • R restart</div>
    </div>
  </div>
`);

// refs are ready synchronously after mount
void loadHi();
fit();
updateStats();
updateOverlay();
requestAnimationFrame(step);
