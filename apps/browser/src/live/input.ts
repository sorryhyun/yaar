/**
 * The human's pointer, wheel and keyboard, forwarded into the remote tab as CDP
 * input events — plus the viewport sync, which is what makes the remote page lay
 * out for the window it is actually being watched in.
 */
import { getCanvas, isLiveConnected, send, remoteW, remoteH, setRemoteSize } from './context';
import { markInput } from './stats';
import { isImeKey, focusRemoteKeyboard, placeAnchor, requestCaret } from './ime';

/** CDP modifier bits. */
const ALT = 1;
const CTRL = 2;
const META = 4;
const SHIFT = 8;

const BUTTON_NAMES = ['left', 'middle', 'right', 'back', 'forward'] as const;

function modifiersOf(e: MouseEvent | KeyboardEvent | WheelEvent): number {
  return (
    (e.altKey ? ALT : 0) |
    (e.ctrlKey ? CTRL : 0) |
    (e.metaKey ? META : 0) |
    (e.shiftKey ? SHIFT : 0)
  );
}

/** Canvas-relative client coordinates → remote page CSS pixels. */
function toRemote(e: MouseEvent): { x: number; y: number } | null {
  const canvas = getCanvas();
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  return {
    x: ((e.clientX - rect.left) / rect.width) * remoteW(),
    y: ((e.clientY - rect.top) / rect.height) * remoteH(),
  };
}

// ── Pointer ───────────────────────────────────────────────────────────────

// Pointer moves are coalesced to one per animation frame: a trackpad emits far more
// than 60 mousemoves/second and every one of them would be a CDP round trip.
let queuedMove: { x: number; y: number; buttons: number; modifiers: number } | null = null;
let moveScheduled = false;

function flushMove(): void {
  moveScheduled = false;
  if (!queuedMove) return;
  send({ t: 'mouse', type: 'mouseMoved', ...queuedMove });
  queuedMove = null;
}

/** press and release differ only in the CDP event name. */
function sendMouseButton(
  type: 'mousePressed' | 'mouseReleased',
  e: MouseEvent,
  p: { x: number; y: number },
): void {
  send({
    t: 'mouse',
    type,
    ...p,
    button: BUTTON_NAMES[e.button] ?? 'left',
    buttons: e.buttons,
    clickCount: e.detail || 1,
    modifiers: modifiersOf(e),
  });
}

export function onCanvasMouseMove(e: MouseEvent): void {
  const p = toRemote(e);
  if (!p) return;
  queuedMove = { ...p, buttons: e.buttons, modifiers: modifiersOf(e) };
  if (e.buttons) markInput();
  if (!moveScheduled) {
    moveScheduled = true;
    requestAnimationFrame(flushMove);
  }
}

export function onCanvasMouseDown(e: MouseEvent): void {
  e.preventDefault();
  focusRemoteKeyboard();
  const p = toRemote(e);
  if (!p) return;
  markInput();
  // A click is how the caret moves in the remote page, so it is also when the
  // anchor has to follow. Park it on the click first — right in the common case
  // and instant — then let the page's own answer correct it once it has focused
  // whatever was clicked.
  placeAnchor(p.x, p.y, 18);
  requestCaret(150);
  sendMouseButton('mousePressed', e, p);
}

export function onCanvasMouseUp(e: MouseEvent): void {
  e.preventDefault();
  const p = toRemote(e);
  if (!p) return;
  markInput();
  sendMouseButton('mouseReleased', e, p);
}

export function onCanvasWheel(e: WheelEvent): void {
  e.preventDefault();
  const p = toRemote(e);
  if (!p) return;
  markInput();
  // deltaMode 1 is lines, 2 is pages; CDP wants pixels either way.
  const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? remoteH() : 1;
  send({
    t: 'mouse',
    type: 'mouseWheel',
    ...p,
    deltaX: e.deltaX * scale,
    deltaY: e.deltaY * scale,
    modifiers: modifiersOf(e),
  });
}

export function onCanvasContextMenu(e: MouseEvent): void {
  // The remote page gets the right-click (as a mousePressed above); showing this
  // iframe's own context menu on top of it would be showing the wrong page's menu.
  e.preventDefault();
}

// ── Keyboard ────────────────────────────────────────────────────────────
//
// A printable key goes as `keyDown` carrying `text`, which is what makes Chrome
// insert the character; everything else goes as `rawKeyDown`, which fires the
// page's handlers without inserting anything.
//
// A key the IME has claimed goes nowhere at all: it is not ours to forward, and
// `preventDefault` on it would break composition outright. What the remote page
// gets instead is the composed text, from ime.ts.

/** The identity half of a CDP key event, shared by keyDown and keyUp. */
function keyPayload(e: KeyboardEvent) {
  return {
    t: 'key',
    key: e.key,
    code: e.code,
    windowsVirtualKeyCode: e.keyCode,
    modifiers: modifiersOf(e),
  };
}

/** True when this keystroke is ours to forward — and claims it if so. */
function claimKey(e: KeyboardEvent): boolean {
  if (!isLiveConnected()) return false;
  if (isImeKey(e)) return false;
  e.preventDefault();
  return true;
}

export function onCanvasKeyDown(e: KeyboardEvent): void {
  if (!claimKey(e)) return;
  markInput();
  const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey;
  send({
    ...keyPayload(e),
    type: printable ? 'keyDown' : 'rawKeyDown',
    ...(printable ? { text: e.key, unmodifiedText: e.key.toLowerCase() } : {}),
  });
}

export function onCanvasKeyUp(e: KeyboardEvent): void {
  if (!claimKey(e)) return;
  send({ ...keyPayload(e), type: 'keyUp' });
}

export function onCanvasPaste(e: ClipboardEvent): void {
  if (!isLiveConnected()) return;
  const text = e.clipboardData?.getData('text/plain');
  if (!text) return;
  e.preventDefault();
  markInput();
  send({ t: 'text', text });
}

// ── Viewport ────────────────────────────────────────────────────────────

/**
 * Re-emulate the remote viewport at the size of the canvas area, so the page
 * reflows to the window the human is looking at instead of being a 1280px
 * desktop layout scaled into a small frame.
 *
 * Debounced because a window drag emits a resize per pointer move, and each one
 * of these is a full re-layout in the remote tab. Note that this leaves the
 * session's viewport where live mode left it — a spike-grade shortcut; P0 owns
 * viewport as part of session lifecycle.
 */
let resizeTimer: ReturnType<typeof setTimeout> | null = null;

export function syncViewport(width: number, height: number): void {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    resizeTimer = null;
    if (width < 320 || height < 240) return;
    const w = Math.round(width);
    const h = Math.round(height);
    send({ t: 'viewport', width: w, height: h });
    // The viewport just asked for is the coordinate space the remote page is in from
    // now on. A frame normally establishes it, but a page that never repaints sends
    // none — and the canvas is no longer blank in that case (seed.ts), so a click on
    // it has to map correctly before the first frame ever arrives.
    setRemoteSize(w, h);
  }, 250);
}
