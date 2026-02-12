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

// --- UI / Canvas ---

const style = document.createElement('style');
style.textContent = `
  :root { color-scheme: dark; }
  html, body { height: 100%; }
  body {
    margin: 0;
    font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
    background: radial-gradient(1200px 900px at 20% 0%, #1b2440 0%, #0b0f1a 55%, #070910 100%);
    color: #e9eefc;
    display: grid;
    place-items: center;
  }
  #app {
    display: flex;
    gap: 16px;
    padding: 18px;
    border-radius: 18px;
    background: rgba(10, 13, 25, 0.7);
    box-shadow: 0 10px 35px rgba(0,0,0,0.45);
    border: 1px solid rgba(255,255,255,0.08);
    backdrop-filter: blur(10px);
  }
  .panel {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 210px;
  }
  .title {
    font-weight: 800;
    letter-spacing: 0.3px;
    font-size: 18px;
  }
  .card {
    background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 14px;
    padding: 12px;
  }
  .stat {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 8px;
    font-size: 14px;
    opacity: 0.95;
  }
  .stat b { font-variant-numeric: tabular-nums; }
  .help {
    font-size: 12px;
    line-height: 1.35;
    opacity: 0.85;
  }
  canvas {
    image-rendering: pixelated;
    background: rgba(0,0,0,0.35);
    border-radius: 12px;
    border: 1px solid rgba(255,255,255,0.08);
  }
  .miniWrap { display: flex; gap: 10px; }
  .miniCol { display:flex; flex-direction: column; gap: 8px; }
  .miniLabel { font-size: 12px; opacity: 0.85; }
  .btnRow { display:flex; gap: 8px; flex-wrap: wrap; }
  button {
    appearance: none;
    border: 1px solid rgba(255,255,255,0.14);
    background: rgba(255,255,255,0.06);
    color: #e9eefc;
    padding: 8px 10px;
    border-radius: 10px;
    font-weight: 650;
    cursor: pointer;
  }
  button:hover { background: rgba(255,255,255,0.10); }
  button:active { transform: translateY(1px); }
  .overlay {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    pointer-events: none;
  }
  .overlayBox {
    pointer-events: none;
    text-align: center;
    padding: 14px 16px;
    border-radius: 14px;
    background: rgba(0,0,0,0.55);
    border: 1px solid rgba(255,255,255,0.10);
    max-width: 320px;
  }
  .overlayBox h2 { margin: 0 0 6px 0; font-size: 18px; }
  .overlayBox p { margin: 0; font-size: 13px; opacity: 0.9; }
`;

document.head.appendChild(style);

document.body.innerHTML = '';

const app = document.createElement('div');
app.id = 'app';

const boardWrap = document.createElement('div');
boardWrap.style.position = 'relative';

const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d')!;

const overlay = document.createElement('div');
overlay.className = 'overlay';
const overlayBox = document.createElement('div');
overlayBox.className = 'overlayBox';
overlay.appendChild(overlayBox);

boardWrap.appendChild(canvas);
boardWrap.appendChild(overlay);

const panel = document.createElement('div');
panel.className = 'panel';

const title = document.createElement('div');
title.className = 'title';
title.textContent = 'Falling Blocks';

const statsCard = document.createElement('div');
statsCard.className = 'card';

const statScore = document.createElement('div');
statScore.className = 'stat';
const statLines = document.createElement('div');
statLines.className = 'stat';
const statLevel = document.createElement('div');
statLevel.className = 'stat';
const statHi = document.createElement('div');
statHi.className = 'stat';

statsCard.append(statScore, statHi, statLines, statLevel);

const miniCard = document.createElement('div');
miniCard.className = 'card';

const miniWrap = document.createElement('div');
miniWrap.className = 'miniWrap';

function makeMini(label: string): { wrap: HTMLDivElement; c: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const col = document.createElement('div');
  col.className = 'miniCol';
  const lab = document.createElement('div');
  lab.className = 'miniLabel';
  lab.textContent = label;
  const c = document.createElement('canvas');
  const g = c.getContext('2d')!;
  col.append(lab, c);
  return { wrap: col, c, g };
}

const nextMini = makeMini('Next');
const holdMini = makeMini('Hold');
miniWrap.append(nextMini.wrap, holdMini.wrap);
miniCard.appendChild(miniWrap);

const btnCard = document.createElement('div');
btnCard.className = 'card';
const btnRow = document.createElement('div');
btnRow.className = 'btnRow';
const btnRestart = document.createElement('button');
btnRestart.textContent = 'Restart (R)';
const btnPause = document.createElement('button');
btnPause.textContent = 'Pause (P)';
btnRow.append(btnRestart, btnPause);
btnCard.appendChild(btnRow);

const help = document.createElement('div');
help.className = 'help';
help.textContent = '←/→ move • ↑ rotate • ↓ soft drop • Space hard drop • C hold • P pause • R restart';

panel.append(title, statsCard, miniCard, btnCard, help);
app.append(boardWrap, panel);
document.body.appendChild(app);

// --- Game state ---

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

const HI_KEY = 'falling-blocks:hi';
let hi = Number(localStorage.getItem(HI_KEY) ?? '0') || 0;

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
  updateOverlay();
}

function updateHi(): void {
  if (score > hi) {
    hi = score;
    localStorage.setItem(HI_KEY, String(hi));
  }
}

function updateStats(): void {
  statScore.innerHTML = `<span>Score</span><b>${score}</b>`;
  statHi.innerHTML = `<span>High</span><b>${hi}</b>`;
  statLines.innerHTML = `<span>Lines</span><b>${lines}</b>`;
  statLevel.innerHTML = `<span>Level</span><b>${level}</b>`;
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
}

function softDrop(): void {
  if (!tryMove(0, 1)) {
    lockAndAdvance();
  } else {
    // tiny reward for moving down manually
    score += 1;
    updateHi();
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
  }
}

function rotateCurrent(): void {
  if (gameOver || paused) return;
  const rotated = rotateCW(current.m);
  // simple wall-kick attempts
  const kicks = [0, -1, 1, -2, 2];
  for (const k of kicks) {
    if (!collides(board, current, k, 0, rotated)) {
      current.m = rotated;
      current.x += k;
      return;
    }
  }
}

function updateOverlay(): void {
  if (gameOver) {
    overlayBox.innerHTML = `<h2>Game Over</h2><p>Press R to restart.</p>`;
    overlay.style.display = 'grid';
  } else if (paused) {
    overlayBox.innerHTML = `<h2>Paused</h2><p>Press P to resume.</p>`;
    overlay.style.display = 'grid';
  } else {
    overlay.style.display = 'none';
  }
}

// --- Rendering ---

let BLOCK = 26;

function fit(): void {
  // Keep the board comfortable in the window.
  const maxH = Math.min(760, window.innerHeight - 120);
  BLOCK = Math.max(18, Math.floor(maxH / ROWS));

  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${COLS * BLOCK}px`;
  canvas.style.height = `${ROWS * BLOCK}px`;
  canvas.width = Math.floor(COLS * BLOCK * dpr);
  canvas.height = Math.floor(ROWS * BLOCK * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const miniSize = Math.floor(BLOCK * 0.9);
  for (const { c } of [nextMini, holdMini]) {
    c.style.width = `${miniSize * 4}px`;
    c.style.height = `${miniSize * 4}px`;
    c.width = Math.floor(miniSize * 4 * dpr);
    c.height = Math.floor(miniSize * 4 * dpr);
  }
  nextMini.g.setTransform(dpr, 0, 0, dpr, 0, 0);
  holdMini.g.setTransform(dpr, 0, 0, dpr, 0, 0);
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
  nextMini.g.setTransform(dpr, 0, 0, dpr, 0, 0);
  nextMini.g.clearRect(0, 0, miniSize * 4, miniSize * 4);
  nextMini.g.fillStyle = 'rgba(0,0,0,0.28)';
  nextMini.g.fillRect(0, 0, miniSize * 4, miniSize * 4);
  nextMini.g.save();
  nextMini.g.scale(miniSize / BLOCK, miniSize / BLOCK);
  drawMatrix(nextMini.g, next.m, 0, 0, 1);
  nextMini.g.restore();

  // Hold
  holdMini.g.setTransform(dpr, 0, 0, dpr, 0, 0);
  holdMini.g.clearRect(0, 0, miniSize * 4, miniSize * 4);
  holdMini.g.fillStyle = 'rgba(0,0,0,0.28)';
  holdMini.g.fillRect(0, 0, miniSize * 4, miniSize * 4);
  if (hold) {
    const hp = spawn(hold);
    holdMini.g.save();
    holdMini.g.scale(miniSize / BLOCK, miniSize / BLOCK);
    drawMatrix(holdMini.g, hp.m, 0, 0, canHold ? 1 : 0.6);
    holdMini.g.restore();
  }

  updateStats();
  updateOverlay();
}

// --- Loop ---

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

function togglePause(): void {
  if (gameOver) return;
  paused = !paused;
  updateOverlay();
}

btnRestart.onclick = () => reset();
btnPause.onclick = () => togglePause();

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

fit();
updateStats();
updateOverlay();
requestAnimationFrame(step);

export {};
