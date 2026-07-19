/**
 * Mascot — a tiny SD character that lives on the desktop.
 *
 * The window is frameless and transparent; the character inside is the whole UI.
 * It wanders by moving its own window (invoke yaar://windows/{id} move) in small
 * hops smoothed by the windowStyle CSS transition, can be grabbed and dragged
 * (pointer capture inside the iframe, throttled move invokes), and gets dizzy
 * when something else moves its window (the server publishes user interactions
 * as `user` stream frames on the window URI).
 */
import { invoke, list, stream, app, defineCommand } from '@bundled/yaar';
import './styles.css';

type Mood = 'idle' | 'walk' | 'held' | 'dizzy';

const APP_ID = 'mascot';
const WIN_W = 150;
const WIN_H = 190;
const STEP_PX = 30; // one hop
const STEP_MS = 260; // hop cadence — matches the windowStyle transition duration
const DRAG_SEND_MS = 120; // throttle for move invokes while held
const EDGE = 12; // margin from viewport edges
const PALETTE_INSET = 110; // bottom strip reserved for the command palette
const DIZZY_MS = 1600;

// ── State ────────────────────────────────────────────────────────

let windowUri: string | null = null;
let mood: Mood = 'idle';
let walkTarget: { x: number; y: number } | null = null;
let walkTimer: ReturnType<typeof setInterval> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let dizzyTimer: ReturnType<typeof setTimeout> | null = null;
let bubbleTimer: ReturnType<typeof setTimeout> | null = null;
let lastDragSend = 0;
let dragBase: { x: number; y: number } | null = null;
let dragStart: { x: number; y: number } | null = null;
let dragPending: { x: number; y: number } | null = null;

// ── DOM ──────────────────────────────────────────────────────────

const mount = document.getElementById('app')!;
mount.innerHTML = `
  <div class="bubble"></div>
  <div class="hit" data-mood="idle">
    <div class="flip" data-facing="1">
      <div class="chara">
        <div class="shadow"></div>
        <div class="torso">
          <div class="wing l"></div>
          <div class="wing r"></div>
          <div class="eye l"></div>
          <div class="eye r"></div>
          <div class="beak"></div>
          <div class="cheek l"></div>
          <div class="cheek r"></div>
        </div>
        <div class="foot l"></div>
        <div class="foot r"></div>
      </div>
    </div>
  </div>
`;
const bubbleEl = mount.querySelector<HTMLElement>('.bubble')!;
const hitEl = mount.querySelector<HTMLElement>('.hit')!;
const flipEl = mount.querySelector<HTMLElement>('.flip')!;

function setMood(next: Mood): void {
  mood = next;
  hitEl.dataset.mood = next;
}

function setFacing(dx: number): void {
  if (dx !== 0) flipEl.dataset.facing = dx < 0 ? '-1' : '1';
}

function say(text: string, ms = 3500): void {
  bubbleEl.textContent = text;
  bubbleEl.dataset.visible = 'true';
  if (bubbleTimer) clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => {
    bubbleEl.dataset.visible = 'false';
  }, ms);
}

// ── Geometry (same-origin: read our own frame's place on the desktop) ──

function getPos(): { x: number; y: number } | null {
  const fe = window.frameElement;
  const host = fe?.closest?.('[data-window-id]') ?? fe;
  const r = host?.getBoundingClientRect();
  return r ? { x: r.left, y: r.top } : null;
}

function getViewport(): { w: number; h: number } {
  try {
    if (window.parent && window.parent !== window) {
      return { w: window.parent.innerWidth, h: window.parent.innerHeight };
    }
  } catch {
    /* cross-origin fallback below */
  }
  return { w: screen.availWidth, h: screen.availHeight };
}

function moveWindow(x: number, y: number): void {
  if (!windowUri) return;
  invoke(windowUri, { action: 'move', x: Math.round(x), y: Math.round(y) }).catch(() => {});
}

// ── Wandering ────────────────────────────────────────────────────

function stopWalk(): void {
  if (walkTimer) {
    clearInterval(walkTimer);
    walkTimer = null;
  }
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  walkTarget = null;
}

function scheduleIdle(): void {
  stopWalk();
  setMood('idle');
  idleTimer = setTimeout(startWalk, 2500 + Math.random() * 4500);
}

function startWalk(): void {
  if (mood === 'held' || mood === 'dizzy') return;
  if (document.hidden || !windowUri) {
    scheduleIdle();
    return;
  }
  const vp = getViewport();
  const maxX = Math.max(EDGE, vp.w - WIN_W - EDGE);
  const maxY = Math.max(EDGE, vp.h - PALETTE_INSET - WIN_H);
  walkTarget = {
    x: EDGE + Math.random() * (maxX - EDGE),
    y: EDGE + Math.random() * (maxY - EDGE),
  };
  setMood('walk');
  walkTimer = setInterval(walkStep, STEP_MS);
  walkStep();
}

function walkStep(): void {
  const cur = getPos();
  if (!cur || !walkTarget || mood !== 'walk') {
    scheduleIdle();
    return;
  }
  const dx = walkTarget.x - cur.x;
  const dy = walkTarget.y - cur.y;
  const dist = Math.hypot(dx, dy);
  setFacing(dx);
  if (dist <= STEP_PX) {
    moveWindow(walkTarget.x, walkTarget.y);
    scheduleIdle();
    return;
  }
  moveWindow(cur.x + (dx / dist) * STEP_PX, cur.y + (dy / dist) * STEP_PX);
}

// ── Grab & drag (pointer capture keeps events flowing outside the iframe) ──

function goDizzy(then: () => void = scheduleIdle): void {
  stopWalk();
  setMood('dizzy');
  if (dizzyTimer) clearTimeout(dizzyTimer);
  dizzyTimer = setTimeout(() => {
    if (mood === 'dizzy') then();
  }, DIZZY_MS);
}

hitEl.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  hitEl.setPointerCapture(e.pointerId);
  stopWalk();
  if (dizzyTimer) clearTimeout(dizzyTimer);
  setMood('held');
  // screenX/Y are stable while the window itself moves under the pointer;
  // client coordinates would feed back into the move we just made.
  dragBase = getPos();
  dragStart = { x: e.screenX, y: e.screenY };
  dragPending = null;
});

hitEl.addEventListener('pointermove', (e) => {
  if (mood !== 'held' || !dragBase || !dragStart) return;
  const next = {
    x: dragBase.x + (e.screenX - dragStart.x),
    y: dragBase.y + (e.screenY - dragStart.y),
  };
  dragPending = next;
  const now = Date.now();
  if (now - lastDragSend >= DRAG_SEND_MS) {
    lastDragSend = now;
    moveWindow(next.x, next.y);
  }
});

function endDrag(): void {
  if (mood !== 'held') return;
  if (dragPending) moveWindow(dragPending.x, dragPending.y);
  dragBase = dragStart = dragPending = null;
  say('@_@', 1400);
  goDizzy();
}

hitEl.addEventListener('pointerup', endDrag);
hitEl.addEventListener('pointercancel', endDrag);

// ── React when something ELSE moves the window ───────────────────
// The server publishes user window interactions (frame drags, resizes) as
// `user` stream frames; our own move invokes never produce them.

function watchOwnWindow(): void {
  if (!windowUri) return;
  stream(
    windowUri,
    (frame) => {
      const d = frame.data as { type?: string } | null;
      if (mood === 'held') return;
      if (d?.type === 'window.move' || d?.type === 'window.resize') {
        say('!?', 1200);
        goDizzy();
      }
    },
    { kinds: ['user'] },
  ).catch(() => {});
}

// ── Find our own window ──────────────────────────────────────────

interface WindowLink {
  uri?: string;
  description?: string;
}

async function findSelf(attempt = 0): Promise<void> {
  try {
    const entries = await list<WindowLink[]>('yaar://windows');
    const mine = Array.isArray(entries)
      ? entries.find((w) => w.uri && w.description?.includes(`app:${APP_ID}`))
      : undefined;
    if (mine?.uri) {
      windowUri = mine.uri;
      watchOwnWindow();
      scheduleIdle();
      say('삐약!', 2500);
      return;
    }
  } catch {
    /* retry below */
  }
  if (attempt < 5) {
    setTimeout(() => findSelf(attempt + 1), 1000);
  } else {
    // No window handle — stay put and at least animate in place.
    scheduleIdle();
  }
}

// ── App protocol: let agents command the mascot ──────────────────

if (app) {
  app.register({
    appId: APP_ID,
    name: 'Mascot',
    state: {
      mascot: {
        description: 'Current mood, facing direction, and desktop position of the mascot',
        handler: () => ({ mood, facing: flipEl.dataset.facing, position: getPos() }),
      },
    },
    commands: {
      walk_to: defineCommand({
        description: 'Make the mascot walk to a desktop position (top-left of its window)',
        params: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'number' } },
          required: ['x', 'y'],
        },
        handler: (p) => {
          stopWalk();
          if (dizzyTimer) clearTimeout(dizzyTimer);
          walkTarget = { x: p.x, y: p.y };
          setMood('walk');
          walkTimer = setInterval(walkStep, STEP_MS);
          walkStep();
          return { ok: true };
        },
      }),
      say: defineCommand({
        description: 'Show a short speech bubble above the mascot',
        params: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
        handler: (p) => {
          say(String(p.text).slice(0, 40));
          return { ok: true };
        },
      }),
    },
  });
}

// ── Boot ─────────────────────────────────────────────────────────

setMood('idle');
findSelf();
