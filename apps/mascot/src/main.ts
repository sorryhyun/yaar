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
import ART_SRC from './assets/bocchi-sd.png';
import './styles.css';

type Mood = 'idle' | 'walk' | 'held' | 'dizzy';

const APP_ID = 'mascot';
const WIN_W = 150;
const WIN_H = 190;
const STEP_PX = 30; // legacy hop size — kept only to derive the walking speed
const STEP_MS = 260; // legacy hop cadence — ditto
const WALK_PX_PER_MS = STEP_PX / STEP_MS; // same average speed, now continuous
const WALK_DT_MAX = 100; // clamp dt so a backgrounded tab doesn't teleport us
const DRAG_SEND_MS = 120; // throttle for move invokes while held
const EDGE = 12; // margin from viewport edges
const PALETTE_INSET = 110; // bottom strip reserved for the command palette
const DIZZY_MS = 1600;

// Character artwork, base64-inlined into the bundle by the compiler's asset
// loader. It used to be fetched from image-edit's storage, which broke because
// `<img src>` cannot send X-Iframe-Token and the storage route 403'd — the
// broken-image icon. Owning the file also drops the cross-app permission and
// the runtime fetch entirely, so the app is self-contained.

// ── State ────────────────────────────────────────────────────────

let windowUri: string | null = null;
let mood: Mood = 'idle';
let walkTarget: { x: number; y: number } | null = null;
let walkRaf: number | null = null;
let walkLast = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let dizzyTimer: ReturnType<typeof setTimeout> | null = null;
let bubbleTimer: ReturnType<typeof setTimeout> | null = null;
let lastDragSend = 0;
let dragBase: { x: number; y: number } | null = null;
let dragStart: { x: number; y: number } | null = null;
let dragPending: { x: number; y: number } | null = null;
let uncommitted = false; // moved the frame locally; server not told yet

/**
 * The window manager applies windowStyle.transition as an INLINE style on our
 * frame, so clearing it with `style.transition = ''` deletes it permanently
 * rather than falling back to a stylesheet rule. We stash the real value the
 * first time we suppress it and put exactly that back afterwards.
 */
let baseTransition: string | null = null;
let transitionSuppressed = false;

// ── DOM ──────────────────────────────────────────────────────────

const mount = document.getElementById('app')!;
mount.innerHTML = `
  <div class="bubble"></div>
  <div class="hit" data-mood="idle">
    <div class="flip" data-facing="1">
      <div class="chara">
        <div class="shadow"></div>
        <div class="body">
          <img class="art" src="${ART_SRC}" alt="" draggable="false">
        </div>
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

/**
 * Where we believe our window is, in the same coordinate space `move` accepts.
 *
 * Deliberately NOT re-measured every hop. `getBoundingClientRect()` is
 * viewport-relative and, worse, reports the *animated* position while the
 * windowStyle `left/top` transition is mid-flight — so with STEP_MS equal to the
 * transition duration every tick read a position the window had already left,
 * the remaining distance never fell below STEP_PX, and walkStep spammed
 * `window.move` forever. We command the position, so we know it exactly; the
 * DOM only has to seed it once and correct it when someone else moves us.
 */
let pos: { x: number; y: number } | null = null;

/** Our own window frame on the desktop. Same-origin, so we can both read and nudge it. */
function getHostEl(): HTMLElement | null {
  const fe = window.frameElement;
  return (fe?.closest?.('[data-window-id]') ?? fe) as HTMLElement | null;
}

/** Read the window frame's inline left/top — the transition *target*, in desktop coords. */
function readHostPos(): { x: number; y: number } | null {
  const host = getHostEl();
  if (!host) return null;
  const x = parseFloat(host.style.left);
  const y = parseFloat(host.style.top);
  if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
  // No inline style yet — offsetLeft/Top are already offsetParent-relative.
  return { x: host.offsetLeft, y: host.offsetTop };
}

function getPos(): { x: number; y: number } | null {
  if (!pos) pos = readHostPos();
  return pos;
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

/**
 * Move ourselves WITHOUT telling the server.
 *
 * Every `invoke(..., 'move')` is recorded as a user interaction on the OS
 * timeline, so a drag at DRAG_SEND_MS or a walk at STEP_MS used to write a
 * `<ui:move>` entry several times a second. The frame is same-origin, so we
 * can set its left/top ourselves for the intermediate frames and commit the
 * real move exactly once when the motion settles (see commitPos).
 *
 * If the frame is somehow unreachable we fall back to the server move so the
 * mascot still goes where it is told — callers throttle that path.
 */
function moveWindow(x: number, y: number): void {
  const next = { x: Math.round(x), y: Math.round(y) };
  pos = next; // we commanded it, so this is where we are — no re-measure needed
  const host = getHostEl();
  if (host) {
    host.style.left = `${next.x}px`;
    host.style.top = `${next.y}px`;
    uncommitted = true;
    return;
  }
  if (windowUri) invoke(windowUri, { action: 'move', ...next }).catch(() => {});
}

/** Tell the server where we ended up — one move invoke, one timeline entry. */
function commitPos(): void {
  if (!uncommitted || !pos || !windowUri) return;
  uncommitted = false;
  invoke(windowUri, { action: 'move', x: pos.x, y: pos.y }).catch(() => {});
}

// ── Frame transition ─────────────────────────────────────────────
// Whenever we drive the frame ourselves — per rAF frame while walking, per
// pointermove while dragging — the CSS transition is pure lag on top of motion
// we are already interpolating, so it goes off. The suppressed flag makes both
// helpers idempotent, so a drag starting mid-walk (or a walk right after a
// drag) can't stash 'none' as the base value and leak it between modes.

function suppressTransition(): void {
  const host = getHostEl();
  if (!host || transitionSuppressed) return;
  if (baseTransition === null) baseTransition = host.style.transition;
  host.style.transition = 'none';
  transitionSuppressed = true;
}

function restoreTransition(): void {
  const host = getHostEl();
  if (!host || !transitionSuppressed) return;
  host.style.transition = baseTransition ?? '';
  transitionSuppressed = false;
}

// ── Wandering ────────────────────────────────────────────────────

function stopWalkLoop(): void {
  if (walkRaf !== null) {
    cancelAnimationFrame(walkRaf);
    walkRaf = null;
  }
}

function stopWalk(): void {
  stopWalkLoop();
  restoreTransition();
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  walkTarget = null;
}

function scheduleIdle(): void {
  stopWalk();
  // The hop loop moved the frame silently; settle up now that we've stopped.
  commitPos();
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
  startWalkLoop();
}

/** Begin interpolating toward walkTarget, one animation frame at a time. */
function startWalkLoop(): void {
  stopWalkLoop();
  suppressTransition();
  walkLast = performance.now();
  walkRaf = requestAnimationFrame(walkFrame);
}

function walkFrame(now: number): void {
  walkRaf = null;
  const cur = getPos();
  if (!cur || !walkTarget || mood !== 'walk') {
    scheduleIdle();
    return;
  }
  const dt = Math.min(now - walkLast, WALK_DT_MAX);
  walkLast = now;
  const dx = walkTarget.x - cur.x;
  const dy = walkTarget.y - cur.y;
  const dist = Math.hypot(dx, dy);
  setFacing(dx);
  const step = WALK_PX_PER_MS * dt;
  if (dist <= step || dist < 1) {
    moveWindow(walkTarget.x, walkTarget.y);
    scheduleIdle(); // stopWalk restores the transition, then we commit once
    return;
  }
  moveWindow(cur.x + (dx / dist) * step, cur.y + (dy / dist) * step);
  walkRaf = requestAnimationFrame(walkFrame);
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
  // Following a pointer directly — the transition would only add lag.
  suppressTransition();
});

hitEl.addEventListener('pointermove', (e) => {
  if (mood !== 'held' || !dragBase || !dragStart) return;
  const next = {
    x: dragBase.x + (e.screenX - dragStart.x),
    y: dragBase.y + (e.screenY - dragStart.y),
  };
  dragPending = next;
  // moveWindow is local-only when the frame is reachable, so this is free —
  // the throttle only matters on the invoke fallback path.
  if (getHostEl()) {
    moveWindow(next.x, next.y);
    return;
  }
  const now = Date.now();
  if (now - lastDragSend >= DRAG_SEND_MS) {
    lastDragSend = now;
    moveWindow(next.x, next.y);
  }
});

function endDrag(): void {
  if (mood !== 'held') return;
  restoreTransition();
  if (dragPending) moveWindow(dragPending.x, dragPending.y);
  commitPos(); // single move invoke for the whole drag
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
      const d = frame.data as { type?: string; bounds?: { x: number; y: number } } | null;
      // Someone else moved us, so our commanded position is stale — the frame
      // carries the authoritative bounds, so adopt them rather than re-measuring
      // a window that is still mid-transition.
      if (d?.bounds && Number.isFinite(d.bounds.x) && Number.isFinite(d.bounds.y)) {
        pos = { x: d.bounds.x, y: d.bounds.y };
        uncommitted = false; // theirs is authoritative; don't re-commit ours over it
      }
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
          startWalkLoop();
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

// A silent hop that never got committed would be lost if we go away mid-walk.
window.addEventListener('pagehide', commitPos);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) commitPos();
});

setMood('idle');
findSelf();
    