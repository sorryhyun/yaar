/**
 * Live mode — the pre-P0 spike for the interactive browser.
 *
 * The still-screenshot path above this file polls a WebP every 200 ms and shows
 * the agent's browser. Live mode opens a WebSocket to
 * `/api/browser/{id}/screencast`, paints CDP frames onto a canvas, and forwards
 * the human's pointer/wheel/key events straight back into the same remote tab.
 *
 * The spike's question is "does this feel good in the hand?", so this file is
 * also the instrument that answers it: `liveStats` carries painted fps, link
 * throughput, server-side drops, and — the number that actually matters —
 * input-to-pixel lag, measured client-side from an input event to the paint of
 * the next frame after it. Client and server clocks are unrelated, so nothing
 * here subtracts one from the other.
 *
 * Not here, on purpose (they are P0, not the spike): a compositor capture mode
 * with an escape hatch, touch, file drop, the agent co-drive lock.
 *
 * IME *is* here, as a second probe — see the anchor section at the bottom. It is
 * P0's highest-risk item ("ships in the first cut or the first cut doesn't
 * ship"), so it gets measured on the spike's socket before P0 commits to a
 * design, on the same principle as the frame counters above.
 */

import { createSignal } from '@bundled/solid-js';
import { withToken } from './token';
import { updateUrlBar } from './store';

export interface LiveStats {
  fps: number;
  kbps: number;
  /** ms from an input event to the paint of the first frame after it. */
  lagMs: number;
  /** Frames the server dropped because this link could not keep up. */
  dropped: number;
}

/**
 * The two levers Chrome's screencast actually has. Named for the link they are
 * meant for, because the spike's remaining open question is whether a phone over
 * Tailscale can be served by ramping these rather than by a real video codec.
 */
export const QUALITY_PRESETS = {
  high: { quality: 70, maxWidth: 0 },
  medium: { quality: 45, maxWidth: 1024 },
  low: { quality: 30, maxWidth: 800 },
} as const;

export type QualityPreset = keyof typeof QUALITY_PRESETS;

export const [liveMode, setLiveMode] = createSignal(false);
export const [quality, setQuality] = createSignal<QualityPreset>('high');
export const [liveStatus, setLiveStatus] = createSignal('');
/**
 * What the IME probe is doing right now — the readout that answers it.
 *
 * `composing` means a preedit is in flight; `caret` / `no caret` says whether the
 * remote page could tell us where to park the candidate window, which is the
 * probe's second question and the one no unit test can answer.
 */
export const [imeStatus, setImeStatus] = createSignal('');
export const [liveStats, setLiveStats] = createSignal<LiveStats>({
  fps: 0,
  kbps: 0,
  lagMs: 0,
  dropped: 0,
});

/** CDP modifier bits. */
const ALT = 1;
const CTRL = 2;
const META = 4;
const SHIFT = 8;

let socket: WebSocket | null = null;
let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
/** The hidden editable that owns the keyboard while live. See the IME section. */
let anchor: HTMLTextAreaElement | null = null;

/** Remote viewport in CSS px, from the last frame's metadata. Drives coordinate mapping. */
let remoteW = 1280;
let remoteH = 800;

/** Timestamp of the most recent input event that has not yet been answered by a frame. */
let pendingInputAt = 0;

// Rolling window for the stats readout.
let windowStart = 0;
let windowFrames = 0;
let windowBytes = 0;
let windowLagTotal = 0;
let windowLagCount = 0;
let lastDropped = 0;

export function setCanvasEl(el: HTMLCanvasElement): void {
  canvas = el;
  ctx = el.getContext('2d', { alpha: false });
}

export function setImeAnchorEl(el: HTMLTextAreaElement): void {
  anchor = el;
}

export function isLiveConnected(): boolean {
  return socket !== null && socket.readyState === WebSocket.OPEN;
}

export function connectLive(browserId: string): void {
  disconnectLive();
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const preset = QUALITY_PRESETS[quality()];
  const params = `?quality=${preset.quality}${preset.maxWidth ? `&maxWidth=${preset.maxWidth}` : ''}`;
  const path = withToken(`/api/browser/${encodeURIComponent(browserId)}/screencast${params}`);
  const ws = new WebSocket(`${scheme}://${window.location.host}${path}`);
  ws.binaryType = 'arraybuffer';
  socket = ws;
  setLiveStatus('Connecting…');
  resetStats();

  ws.onopen = () => setLiveStatus('Waiting for first frame…');

  ws.onmessage = (e) => {
    if (typeof e.data === 'string') {
      handleControlFrame(e.data);
      return;
    }
    void paintFrame(e.data as ArrayBuffer);
  };

  ws.onerror = () => setLiveStatus('Stream error');

  ws.onclose = (e) => {
    if (socket === ws) socket = null;
    setLiveStatus(e.reason || (e.code === 1000 ? 'Stream closed' : `Stream closed (${e.code})`));
  };
}

export function disconnectLive(): void {
  const ws = socket;
  socket = null;
  composing = false;
  setImeStatus('');
  if (anchor) anchor.value = '';
  if (ws && ws.readyState <= WebSocket.OPEN) ws.close(1000, 'left live mode');
}

function handleControlFrame(text: string): void {
  try {
    const msg = JSON.parse(text) as {
      t?: string;
      url?: string;
      title?: string;
      x?: number;
      y?: number;
      h?: number;
      found?: boolean;
    };
    if (msg.t === 'caret') {
      if (typeof msg.x === 'number' && typeof msg.y === 'number') {
        placeAnchor(msg.x, msg.y, msg.h ?? 16);
      } else if (msg.found === false) {
        // The anchor stays where the last click put it — an approximation is
        // better than a candidate window in the corner. Say so in the readout.
        setImeStatus(composing ? 'composing (guessed caret)' : 'no caret');
      }
      return;
    }
    if (msg.t === 'ready') {
      setLiveStatus('Live');
      if (msg.url) updateUrlBar(msg.url, msg.title);
      // Entering live mode is itself a resize, and the ResizeObserver will not say
      // so: it fires once at observe time — while live mode is still off — and then
      // only on an actual geometry change. Without this the remote page stays at
      // whatever viewport it was opened with and the canvas just scales it.
      const area = canvas?.parentElement?.getBoundingClientRect();
      if (area) syncViewport(area.width, area.height);
    }
  } catch {
    /* the only text frames are ours; a malformed one is not worth a channel teardown */
  }
}

/**
 * Decode and paint one frame.
 *
 * Wire format is `[uint32 LE headerLen][JSON header][JPEG]` — see
 * `packages/server/src/websocket/screencast-handlers.ts`.
 */
async function paintFrame(buf: ArrayBuffer): Promise<void> {
  const view = new DataView(buf);
  const headerLen = view.getUint32(0, true);
  if (headerLen === 0 || headerLen + 4 > buf.byteLength) return;

  let header: { w: number; h: number; dropped: number };
  try {
    header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, headerLen)));
  } catch {
    return;
  }

  const jpeg = new Uint8Array(buf, 4 + headerLen);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
  } catch {
    return;
  }

  if (!canvas || !ctx) {
    bitmap.close();
    return;
  }

  remoteW = header.w || remoteW;
  remoteH = header.h || remoteH;
  // The canvas backing store is the *frame's* size, not the remote viewport's:
  // Chrome may scale a frame down, and stretching it back up here would be a
  // second resample on top of the JPEG's.
  if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  if (pendingInputAt) {
    windowLagTotal += performance.now() - pendingInputAt;
    windowLagCount++;
    pendingInputAt = 0;
  }
  windowFrames++;
  windowBytes += buf.byteLength;
  lastDropped = header.dropped ?? lastDropped;
  tickStats();
}

function resetStats(): void {
  windowStart = performance.now();
  windowFrames = 0;
  windowBytes = 0;
  windowLagTotal = 0;
  windowLagCount = 0;
  lastDropped = 0;
  pendingInputAt = 0;
  setLiveStats({ fps: 0, kbps: 0, lagMs: 0, dropped: 0 });
}

function tickStats(): void {
  const elapsed = performance.now() - windowStart;
  if (elapsed < 1000) return;
  setLiveStats({
    fps: Math.round((windowFrames / elapsed) * 1000),
    kbps: Math.round((windowBytes * 8) / elapsed),
    lagMs: windowLagCount ? Math.round(windowLagTotal / windowLagCount) : liveStats().lagMs,
    dropped: lastDropped,
  });
  windowStart = performance.now();
  windowFrames = 0;
  windowBytes = 0;
  windowLagTotal = 0;
  windowLagCount = 0;
}

function send(msg: Record<string, unknown>): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

/**
 * Mark this moment as the input the next painted frame answers.
 *
 * Only the *first* unanswered input is timed. A drag produces a move every few
 * ms, and overwriting the mark each time would measure "time since the last
 * mousemove", which is always near zero and always flattering.
 */
function markInput(): void {
  if (!pendingInputAt) pendingInputAt = performance.now();
}

function modifiersOf(e: MouseEvent | KeyboardEvent | WheelEvent): number {
  return (
    (e.altKey ? ALT : 0) | (e.ctrlKey ? CTRL : 0) | (e.metaKey ? META : 0) | (e.shiftKey ? SHIFT : 0)
  );
}

const BUTTON_NAMES = ['left', 'middle', 'right', 'back', 'forward'] as const;

/** Canvas-relative client coordinates → remote page CSS pixels. */
function toRemote(e: MouseEvent): { x: number; y: number } | null {
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  return {
    x: ((e.clientX - rect.left) / rect.width) * remoteW,
    y: ((e.clientY - rect.top) / rect.height) * remoteH,
  };
}

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
  send({
    t: 'mouse',
    type: 'mousePressed',
    ...p,
    button: BUTTON_NAMES[e.button] ?? 'left',
    buttons: e.buttons,
    clickCount: e.detail || 1,
    modifiers: modifiersOf(e),
  });
}

export function onCanvasMouseUp(e: MouseEvent): void {
  e.preventDefault();
  const p = toRemote(e);
  if (!p) return;
  markInput();
  send({
    t: 'mouse',
    type: 'mouseReleased',
    ...p,
    button: BUTTON_NAMES[e.button] ?? 'left',
    buttons: e.buttons,
    clickCount: e.detail || 1,
    modifiers: modifiersOf(e),
  });
}

export function onCanvasWheel(e: WheelEvent): void {
  e.preventDefault();
  const p = toRemote(e);
  if (!p) return;
  markInput();
  // deltaMode 1 is lines, 2 is pages; CDP wants pixels either way.
  const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? remoteH : 1;
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

/**
 * Keyboard.
 *
 * A printable key goes as `keyDown` carrying `text`, which is what makes Chrome
 * insert the character; everything else goes as `rawKeyDown`, which fires the
 * page's handlers without inserting anything.
 *
 * A key the IME has claimed goes nowhere at all: it is not ours to forward, and
 * `preventDefault` on it would break composition outright. What the remote page
 * gets instead is the composed text, from the handlers below.
 */
export function onCanvasKeyDown(e: KeyboardEvent): void {
  if (!isLiveConnected()) return;
  if (isImeKey(e)) return;
  e.preventDefault();
  markInput();
  const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey;
  send({
    t: 'key',
    type: printable ? 'keyDown' : 'rawKeyDown',
    key: e.key,
    code: e.code,
    windowsVirtualKeyCode: e.keyCode,
    modifiers: modifiersOf(e),
    ...(printable ? { text: e.key, unmodifiedText: e.key.toLowerCase() } : {}),
  });
}

export function onCanvasKeyUp(e: KeyboardEvent): void {
  if (!isLiveConnected()) return;
  if (isImeKey(e)) return;
  e.preventDefault();
  send({
    t: 'key',
    type: 'keyUp',
    key: e.key,
    code: e.code,
    windowsVirtualKeyCode: e.keyCode,
    modifiers: modifiersOf(e),
  });
}

export function onCanvasPaste(e: ClipboardEvent): void {
  if (!isLiveConnected()) return;
  const text = e.clipboardData?.getData('text/plain');
  if (!text) return;
  e.preventDefault();
  markInput();
  send({ t: 'text', text });
}

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
    send({ t: 'viewport', width: Math.round(width), height: Math.round(height) });
  }, 250);
}

// ── IME probe ───────────────────────────────────────────────────────────────
//
// A canvas cannot be composed into. An IME needs a real editable to attach to,
// and it needs one *locally*, in the desktop's own Chrome, because that is where
// the human's keyboard and their OS input method actually are. So the keyboard
// belongs to a hidden textarea parked over the canvas — the anchor — and the
// canvas only ever sees the mouse.
//
// What crosses the wire is therefore not keystrokes but composed text:
// `compositionupdate` → `Input.imeSetComposition` (the underlined preedit),
// `compositionend` → `Input.insertText` (the commit). Two consequences worth
// knowing before P0 builds on this:
//
//   - the remote page never learns which keys were pressed to compose, which is
//     correct — a real IME does not tell it either;
//   - the candidate window is drawn by the local OS at the *anchor's* caret, so
//     the anchor has to be moved onto the remote caret or the candidate list
//     appears in the wrong place. That is what `caret` frames are for, and how
//     well it works is the thing this probe exists to find out.

/** True while the IME owns this keystroke — ours to leave alone, not to forward. */
function isImeKey(e: KeyboardEvent): boolean {
  // 229 is the "handled by IME" virtual key. Chrome fires the very first keydown
  // of a composition with it *before* compositionstart, so `composing` alone is
  // one keystroke too late.
  return composing || e.isComposing || e.keyCode === 229;
}

let composing = false;

/** Give the keyboard to the anchor, so composition has something to attach to. */
export function focusRemoteKeyboard(): void {
  if (anchor) anchor.focus({ preventScroll: true });
  else canvas?.focus();
}

export function onImeStart(): void {
  composing = true;
  setImeStatus('composing');
  markInput();
  requestCaret();
}

export function onImeUpdate(e: CompositionEvent): void {
  if (!isLiveConnected()) return;
  markInput();
  const text = e.data ?? '';
  // The caret sits at the end of the preedit: this is text being assembled, not
  // a selection the human is moving through.
  send({ t: 'ime', text, selStart: text.length, selEnd: text.length });
}

export function onImeEnd(e: CompositionEvent): void {
  composing = false;
  setImeStatus('');
  if (!isLiveConnected()) return;
  markInput();
  const text = e.data ?? '';
  // No data means the composition was erased rather than committed (backspacing
  // the last jamo). Empty text is CDP's cancel; without it the preedit would be
  // left standing in the remote page with nothing to finish it.
  if (text) send({ t: 'text', text });
  else send({ t: 'ime', text: '' });
  requestCaret(120);
}

/**
 * The anchor is an input sink, never a text field.
 *
 * Whatever the IME commits lands in the anchor's own value as well as going to
 * the remote page; left there it would accumulate a shadow copy of everything
 * ever typed, and the next composition would compose against it.
 */
export function onImeInput(): void {
  if (composing || !anchor) return;
  anchor.value = '';
}

/**
 * Ask the remote page where its caret is.
 *
 * Debounced and delayed rather than sent per keystroke: the answer is a
 * `Runtime.evaluate` round trip, and it is only needed when the caret *moves* —
 * a click, a commit, the start of a composition.
 */
let caretTimer: ReturnType<typeof setTimeout> | null = null;

function requestCaret(delayMs = 0): void {
  if (caretTimer) clearTimeout(caretTimer);
  caretTimer = setTimeout(() => {
    caretTimer = null;
    send({ t: 'caret' });
  }, delayMs);
}

/** Park the anchor at a point in the remote page — the inverse of `toRemote`. */
function placeAnchor(x: number, y: number, h: number): void {
  if (!anchor || !canvas) return;
  const sx = canvas.clientWidth / (remoteW || 1);
  const sy = canvas.clientHeight / (remoteH || 1);
  anchor.style.left = `${Math.round(canvas.offsetLeft + x * sx)}px`;
  anchor.style.top = `${Math.round(canvas.offsetTop + y * sy)}px`;
  // The OS draws the candidate window immediately below the caret box, so the
  // height is what keeps the list from covering the line being typed.
  anchor.style.height = `${Math.max(12, Math.round(h * sy))}px`;
  if (composing) setImeStatus('composing');
}
