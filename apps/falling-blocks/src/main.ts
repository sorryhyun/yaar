import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import { appStorage, createPersistedSignal } from '@bundled/yaar';
import './styles.css';
import {
  COLS, ROWS, N, COLORS, GLOW_COLORS,
  makeBoard, collides, merge, clearLines, rotateCW,
  computeDropInterval, pointsForLines, ghostY,
  nextType, resetBag, spawn, spawnParticles,
} from './helpers';
import type { Piece, PieceType, Particle, FlashLine } from './types';
import {
  scoreS, setScoreS, hiS, setHiS, linesS, setLinesS,
  levelS, setLevelS, pausedS, setPausedS, gameOverS, setGameOverS,
  comboS, setComboS,
} from './store';
import { sounds, ensureAudio } from './sound';

// --- Canvas refs ---
let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let nextCanvas!: HTMLCanvasElement;
let nextCtx!: CanvasRenderingContext2D;
let holdCanvas!: HTMLCanvasElement;
let holdCtx!: CanvasRenderingContext2D;
let bgCanvas!: HTMLCanvasElement;
let bgCtx!: CanvasRenderingContext2D;

// --- Mutable game state ---
let board = makeBoard();
let current: Piece = spawn(nextType());
let nextPiece: Piece = spawn(nextType());
let hold: PieceType | null = null;
let canHold = true;
let score = 0;
let lines = 0;
let level = 0;
let combo = 0;
let dropInterval = computeDropInterval(level);
let dropAccum = 0;
let lastTime = 0;
let paused = false;
let gameOver = false;
let hi = 0;
let audioUnlocked = false;

// --- Effects ---
let particles: Particle[] = [];
let flashLines: FlashLine[] = [];
let screenShake = 0;
let bgTime = 0;
let BLOCK = 26;

// --- Persistence ---
// Persisted signal: auto-saves hi on every setPersistedHi() call — no null guard needed
const [, setPersistedHi] = createPersistedSignal<number>('hi', 0);

function updateStats(): void {
  setScoreS(score); setHiS(hi); setLinesS(lines); setLevelS(level); setComboS(combo);
}
function updateOverlay(): void { setGameOverS(gameOver); setPausedS(paused); }
function updateHi(): void {
  if (score > hi) { hi = score; setHiS(hi); setPersistedHi(hi); }
}

// --- Game logic ---
function reset(): void {
  board = makeBoard(); resetBag();
  current = spawn(nextType()); nextPiece = spawn(nextType());
  hold = null; canHold = true;
  score = 0; lines = 0; level = 0; combo = 0;
  dropInterval = computeDropInterval(level); dropAccum = 0;
  paused = false; gameOver = false;
  particles = []; flashLines = []; screenShake = 0;
  updateStats(); updateOverlay();
}

function tryMove(dx: number, dy: number): boolean {
  if (!collides(board, current, dx, dy)) { current.x += dx; current.y += dy; return true; }
  return false;
}

function lockAndAdvance(): void {
  merge(board, current);
  sounds.lock();
  const clearedRows = clearLines(board);
  const numCleared = clearedRows.length;
  if (numCleared > 0) {
    combo++;
    for (const row of clearedRows) {
      for (let x = 0; x < COLS; x++) {
        particles.push(...spawnParticles(row, BLOCK, COLORS[(x % 7) + 1], 8));
      }
      flashLines.push({ row, alpha: 1.0 });
    }
    screenShake = numCleared === 4 ? 12 : 4 + numCleared * 2;
    lines += numCleared;
    score += pointsForLines(numCleared, level, combo);
    const newLevel = Math.floor(lines / 10);
    if (newLevel !== level) {
      level = newLevel;
      dropInterval = computeDropInterval(level);
      sounds.levelUp();
    }
    sounds.clear(numCleared);
  } else { combo = 0; }

  updateHi();
  current = nextPiece;
  current.x = Math.floor(COLS / 2) - 2; current.y = -1;
  nextPiece = spawn(nextType()); canHold = true;
  if (collides(board, current, 0, 0)) { gameOver = true; sounds.gameOver(); }
  updateStats(); updateOverlay();
}

function softDrop(): void {
  if (!tryMove(0, 1)) lockAndAdvance();
  else { score += 1; updateHi(); updateStats(); }
}

function hardDrop(): void {
  if (gameOver || paused) return;
  let dropped = 0;
  while (!collides(board, current, 0, 1)) { current.y++; dropped++; }
  score += dropped * 2; updateHi(); sounds.drop(); lockAndAdvance();
}

function holdPiece(): void {
  if (!canHold || gameOver || paused) return;
  canHold = false;
  const curType = current.type;
  if (hold == null) {
    hold = curType; current = nextPiece;
    current.x = Math.floor(COLS / 2) - 2; current.y = -1;
    nextPiece = spawn(nextType());
  } else {
    current = spawn(hold); hold = curType;
  }
  if (collides(board, current, 0, 0)) { gameOver = true; updateOverlay(); }
}

function rotateCurrent(): void {
  if (gameOver || paused) return;
  const rotated = rotateCW(current.m);
  for (const k of [0, -1, 1, -2, 2]) {
    if (!collides(board, current, k, 0, rotated)) {
      current.m = rotated; current.x += k; sounds.rotate(); return;
    }
  }
}

function togglePause(): void {
  if (gameOver) return;
  paused = !paused; updateOverlay();
}

// --- Background ---
interface Star { x: number; y: number; r: number; speed: number; alpha: number; }
const stars: Star[] = [];
function initStars(): void {
  stars.length = 0;
  const w = COLS * BLOCK; const h = ROWS * BLOCK;
  for (let i = 0; i < 80; i++) {
    stars.push({ x: Math.random() * w, y: Math.random() * h,
      r: 0.5 + Math.random() * 1.5, speed: 0.1 + Math.random() * 0.3,
      alpha: 0.2 + Math.random() * 0.6 });
  }
}
function drawBg(dt: number): void {
  bgTime += dt * 0.001;
  const w = COLS * BLOCK; const h = ROWS * BLOCK;
  bgCtx.clearRect(0, 0, w, h);
  bgCtx.fillStyle = '#06080f'; bgCtx.fillRect(0, 0, w, h);
  for (const s of stars) {
    s.y += s.speed;
    if (s.y > h) { s.y = 0; s.x = Math.random() * w; }
    const tw = 0.5 + 0.5 * Math.sin(bgTime * 2 + s.x);
    bgCtx.save(); bgCtx.globalAlpha = s.alpha * tw;
    bgCtx.fillStyle = '#fff';
    bgCtx.beginPath(); bgCtx.arc(s.x, s.y, s.r, 0, Math.PI * 2); bgCtx.fill();
    bgCtx.restore();
  }
  const h1 = (bgTime * 10) % 360; const h2 = (h1 + 160) % 360;
  bgCtx.save(); bgCtx.globalAlpha = 0.04;
  const g1 = bgCtx.createRadialGradient(w * 0.3, h * 0.4, 0, w * 0.3, h * 0.4, w * 0.6);
  g1.addColorStop(0, `hsl(${h1},80%,50%)`); g1.addColorStop(1, 'transparent');
  bgCtx.fillStyle = g1; bgCtx.fillRect(0, 0, w, h);
  const g2 = bgCtx.createRadialGradient(w * 0.7, h * 0.6, 0, w * 0.7, h * 0.6, w * 0.6);
  g2.addColorStop(0, `hsl(${h2},80%,50%)`); g2.addColorStop(1, 'transparent');
  bgCtx.fillStyle = g2; bgCtx.fillRect(0, 0, w, h);
  bgCtx.restore();
}

// --- Rendering ---
function fit(): void {
  const maxH = Math.min(720, window.innerHeight - 100);
  BLOCK = Math.max(18, Math.floor(maxH / ROWS));
  const dpr = window.devicePixelRatio || 1;
  const cw = COLS * BLOCK; const ch = ROWS * BLOCK;
  for (const c of [canvas, bgCanvas]) {
    c.style.width = `${cw}px`; c.style.height = `${ch}px`;
    c.width = Math.floor(cw * dpr); c.height = Math.floor(ch * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  initStars();
  const ms = Math.floor(BLOCK * 0.85);
  for (const c of [nextCanvas, holdCanvas]) {
    c.style.width = `${ms * 4}px`; c.style.height = `${ms * 4}px`;
    c.width = Math.floor(ms * 4 * dpr); c.height = Math.floor(ms * 4 * dpr);
  }
  nextCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  holdCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function lighten(hex: string, a: number): string {
  const n = parseInt(hex.replace('#',''), 16);
  return `rgb(${Math.min(255,(n>>16)+a)},${Math.min(255,((n>>8)&0xff)+a)},${Math.min(255,(n&0xff)+a)})`;
}
function darken(hex: string, a: number): string {
  const n = parseInt(hex.replace('#',''), 16);
  return `rgb(${Math.max(0,(n>>16)-a)},${Math.max(0,((n>>8)&0xff)-a)},${Math.max(0,(n&0xff)-a)})`;
}

function drawCell(g: CanvasRenderingContext2D, x: number, y: number, v: number, alpha = 1, bsz = BLOCK): void {
  if (!v) return;
  const px = x * bsz; const py = y * bsz;
  const color = COLORS[v];
  g.save(); g.globalAlpha = alpha;
  g.shadowBlur = 10; g.shadowColor = GLOW_COLORS[v];
  const grad = g.createLinearGradient(px, py, px + bsz, py + bsz);
  grad.addColorStop(0, lighten(color, 40));
  grad.addColorStop(0.5, color);
  grad.addColorStop(1, darken(color, 30));
  g.fillStyle = grad;
  g.beginPath(); g.roundRect(px + 1, py + 1, bsz - 2, bsz - 2, 3); g.fill();
  g.shadowBlur = 0; g.globalAlpha = alpha * 0.4;
  g.fillStyle = 'rgba(255,255,255,0.5)';
  g.fillRect(px + 3, py + 3, bsz - 6, 4);
  g.restore();
}

function drawMini(g: CanvasRenderingContext2D, piece: Piece, alpha = 1): void {
  const dpr = window.devicePixelRatio || 1;
  const bsz = Math.floor(BLOCK * 0.85);
  const sz = bsz * 4;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, sz, sz);
  g.fillStyle = 'rgba(0,0,0,0.4)'; g.fillRect(0, 0, sz, sz);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++)
      if (piece.m[y][x]) drawCell(g, x, y, piece.m[y][x], alpha, bsz);
}

function drawFrame(dt: number): void {
  drawBg(dt);
  let sx = 0; let sy = 0;
  if (screenShake > 0) {
    const mag = screenShake * 0.7;
    sx = (Math.random() - 0.5) * mag; sy = (Math.random() - 0.5) * mag;
    screenShake = Math.max(0, screenShake - 0.5);
  }
  ctx.clearRect(0, 0, COLS * BLOCK, ROWS * BLOCK);
  ctx.save(); ctx.translate(sx, sy);

  // grid
  ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.lineWidth = 0.5;
  for (let x = 1; x < COLS; x++) {
    ctx.beginPath(); ctx.moveTo(x * BLOCK, 0); ctx.lineTo(x * BLOCK, ROWS * BLOCK); ctx.stroke();
  }
  for (let y = 1; y < ROWS; y++) {
    ctx.beginPath(); ctx.moveTo(0, y * BLOCK); ctx.lineTo(COLS * BLOCK, y * BLOCK); ctx.stroke();
  }

  // board
  for (let y = 0; y < ROWS; y++)
    for (let x = 0; x < COLS; x++)
      if (board[y][x]) drawCell(ctx, x, y, board[y][x]);

  // flash
  flashLines = flashLines.filter(fl => fl.alpha > 0);
  for (const fl of flashLines) {
    ctx.save(); ctx.globalAlpha = fl.alpha;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillRect(0, fl.row * BLOCK, COLS * BLOCK, BLOCK);
    ctx.restore(); fl.alpha -= 0.07;
  }

  // ghost
  if (!gameOver) {
    const gy = ghostY(board, current);
    if (gy !== current.y) {
      ctx.save(); ctx.globalAlpha = 0.18;
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const v = current.m[y][x]; if (!v) continue;
          ctx.strokeStyle = COLORS[v]; ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.roundRect((current.x+x)*BLOCK+1, (gy+y)*BLOCK+1, BLOCK-2, BLOCK-2, 3);
          ctx.stroke();
        }
      }
      ctx.restore();
    }
  }

  // current
  if (!gameOver)
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++)
        if (current.m[y][x]) drawCell(ctx, current.x+x, current.y+y, current.m[y][x]);

  // particles
  particles = particles.filter(p => p.alpha > 0);
  for (const p of particles) {
    p.x += p.vx; p.y += p.vy; p.vy += 0.15; p.alpha -= 0.025;
    ctx.save(); ctx.globalAlpha = Math.max(0, p.alpha);
    ctx.fillStyle = p.color; ctx.shadowBlur = 6; ctx.shadowColor = p.color;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI*2); ctx.fill();
    ctx.restore();
  }
  ctx.restore();

  // minis
  drawMini(nextCtx, nextPiece, 1);
  if (hold) {
    drawMini(holdCtx, spawn(hold), canHold ? 1 : 0.5);
  } else {
    const dpr = window.devicePixelRatio || 1;
    holdCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    holdCtx.clearRect(0, 0, BLOCK * 4, BLOCK * 4);
    holdCtx.fillStyle = 'rgba(0,0,0,0.4)';
    holdCtx.fillRect(0, 0, BLOCK * 4, BLOCK * 4);
  }
}

function step(time: number): void {
  const dt = lastTime === 0 ? 16 : Math.min(time - lastTime, 50);
  lastTime = time;
  if (!paused && !gameOver) {
    dropAccum += dt;
    if (dropAccum >= dropInterval) { dropAccum = 0; if (!tryMove(0, 1)) lockAndAdvance(); }
  }
  drawFrame(dt);
  requestAnimationFrame(step);
}

window.addEventListener('keydown', (e) => {
  const key = e.key;
  if (['ArrowLeft','ArrowRight','ArrowDown','ArrowUp',' '].includes(key)) e.preventDefault();
  if (!audioUnlocked) { audioUnlocked = true; void ensureAudio(); }
  if (key === 'r' || key === 'R') { reset(); return; }
  if (key === 'p' || key === 'P') { togglePause(); return; }
  if (paused || gameOver) return;
  if (key === 'ArrowLeft') { if (tryMove(-1, 0)) sounds.move(); }
  else if (key === 'ArrowRight') { if (tryMove(1, 0)) sounds.move(); }
  else if (key === 'ArrowDown') softDrop();
  else if (key === 'ArrowUp') rotateCurrent();
  else if (key === ' ') hardDrop();
  else if (key === 'c' || key === 'C') holdPiece();
});
window.addEventListener('resize', fit);

render(() => html`
  <div id="app">
    <div class="game-wrap">
      <canvas id="bg-canvas" ref=${(el: HTMLCanvasElement) => { bgCanvas = el; bgCtx = el.getContext('2d')!; }} />
      <canvas ref=${(el: HTMLCanvasElement) => { canvas = el; ctx = el.getContext('2d')!; }} />
      ${() => (gameOverS() || pausedS())
        ? html`<div class="overlay"><div class="overlayBox">
          ${() => gameOverS()
            ? html`<h2 class="overlay-title game-over-title">GAME OVER</h2><p class="overlay-score">Score: ${() => scoreS()}</p><p class="overlay-hint">Press R to restart</p>`
            : html`<h2 class="overlay-title">PAUSED</h2><p class="overlay-hint">Press P to resume</p>`
          }
        </div></div>`
        : null
      }
    </div>
    <div class="panel">
      <div class="panel-title">FALLING BLOCKS</div>
      <div class="card">
        <div class="stat"><span class="stat-label">SCORE</span><b class="stat-value">${() => scoreS().toLocaleString()}</b></div>
        <div class="stat"><span class="stat-label">BEST</span><b class="stat-value hi-val">${() => hiS().toLocaleString()}</b></div>
        <div class="stat"><span class="stat-label">LINES</span><b class="stat-value">${() => linesS()}</b></div>
        <div class="stat"><span class="stat-label">LEVEL</span><b class="stat-value level-val">${() => levelS()}</b></div>
        ${() => comboS() > 1 ? html`<div class="combo-badge">COMBO x${() => comboS()}!</div>` : null}
      </div>
      <div class="card">
        <div class="mini-wrap">
          <div class="mini-col">
            <div class="mini-label">NEXT</div>
            <div class="mini-canvas-wrap"><canvas ref=${(el: HTMLCanvasElement) => { nextCanvas = el; nextCtx = el.getContext('2d')!; }} /></div>
          </div>
          <div class="mini-col">
            <div class="mini-label">HOLD <span class="hold-hint">[C]</span></div>
            <div class="mini-canvas-wrap"><canvas ref=${(el: HTMLCanvasElement) => { holdCanvas = el; holdCtx = el.getContext('2d')!; }} /></div>
          </div>
        </div>
      </div>
      <div class="card level-bar-card">
        <div class="level-bar-label">Level ${() => levelS()}</div>
        <div class="level-bar-bg"><div class="level-bar-fill" style=${() => `width:${(linesS() % 10) * 10}%`}></div></div>
        <div class="level-bar-lines">${() => linesS() % 10}/10 lines</div>
      </div>
      <div class="card btn-card">
        <button class="y-btn y-btn-primary y-btn-sm" onClick=${() => { reset(); void ensureAudio(); }}>Restart (R)</button>
        <button class="y-btn y-btn-sm" onClick=${() => togglePause()}>Pause (P)</button>
      </div>
      <div class="help">
        <div class="help-row"><kbd>←→</kbd> Move</div>
        <div class="help-row"><kbd>↑</kbd> Rotate</div>
        <div class="help-row"><kbd>↓</kbd> Soft drop</div>
        <div class="help-row"><kbd>Space</kbd> Hard drop</div>
        <div class="help-row"><kbd>C</kbd> Hold</div>
      </div>
    </div>
  </div>
`, document.getElementById('app')!);

// Load saved hi score (handles both legacy {hi:N} object and plain number formats)
void (async () => {
  const raw = await appStorage.readJsonOr<any>('hi.json', null);
  const value = typeof raw === 'number' ? raw : (raw && typeof raw.hi === 'number' ? raw.hi : 0);
  if (value > 0) { hi = value; setHiS(hi); setPersistedHi(value); }
})();
fit();
updateStats();
updateOverlay();
requestAnimationFrame(step);
