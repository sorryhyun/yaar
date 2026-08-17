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
 * Not here, on purpose (they are P0, not the spike): IME composition, a
 * compositor capture mode with an escape hatch, touch, file drop, the agent
 * co-drive lock.
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
  if (ws && ws.readyState <= WebSocket.OPEN) ws.close(1000, 'left live mode');
}

function handleControlFrame(text: string): void {
  try {
    const msg = JSON.parse(text) as { t?: string; url?: string; title?: string };
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
  canvas?.focus();
  const p = toRemote(e);
  if (!p) return;
  markInput();
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
 * Keyboard, without IME.
 *
 * A printable key goes as `keyDown` carrying `text`, which is what makes Chrome
 * insert the character; everything else goes as `rawKeyDown`, which fires the
 * page's handlers without inserting anything. Composed CJK input does not survive
 * this path at all — that is work item 3, and it is P0's to solve, not the spike's.
 */
export function onCanvasKeyDown(e: KeyboardEvent): void {
  if (!isLiveConnected()) return;
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
