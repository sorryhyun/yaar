/**
 * The mutable handles live mode is built on: the socket, the canvas it paints to,
 * the hidden IME anchor parked over that canvas, and the remote viewport every
 * coordinate is expressed in.
 *
 * They were module-level `let`s in one 647-line file; pulled out here they are what
 * lets that file become seven cohesive ones. This module imports nothing, so no
 * live/* module can end up in a cycle by reaching for them.
 */

let socket: WebSocket | null = null;
let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
/** The hidden editable that owns the keyboard while live. See ime.ts. */
let anchor: HTMLTextAreaElement | null = null;

/** Remote viewport in CSS px, from the last frame's metadata. Drives coordinate mapping. */
let remoteWidth = 1280;
let remoteHeight = 800;

export function setCanvasEl(el: HTMLCanvasElement): void {
  canvas = el;
  ctx = el.getContext('2d', { alpha: false });
}

export function setImeAnchorEl(el: HTMLTextAreaElement): void {
  anchor = el;
}

export function getCanvas(): HTMLCanvasElement | null {
  return canvas;
}

export function getCtx(): CanvasRenderingContext2D | null {
  return ctx;
}

export function getAnchor(): HTMLTextAreaElement | null {
  return anchor;
}

export function setSocket(ws: WebSocket | null): void {
  socket = ws;
}

export function getSocket(): WebSocket | null {
  return socket;
}

export function isLiveConnected(): boolean {
  return socket !== null && socket.readyState === WebSocket.OPEN;
}

/** Send a control message, or drop it if the socket is not up. */
export function send(msg: Record<string, unknown>): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

/**
 * The tab the canvas is *meant* to be showing, set the moment a switch is asked for
 * rather than when the server confirms it. A still capture in flight checks it, so a
 * slow one for the tab we left can never land on top of the tab we went to.
 */
let desired: string | null = null;

export function setDesiredTab(id: string | null): void {
  desired = id;
}

export function desiredTab(): string | null {
  return desired;
}

/**
 * `performance.now()` of the last screencast frame painted, or 0 for "none on this
 * connection". Seeds read it twice — before and after their fetch — because a real
 * frame arriving mid-flight is fresher than the capture they are holding.
 */
let lastFrameAt = 0;

export function markFramePainted(): void {
  // `|| 1` so the very first frame can never read back as "none".
  lastFrameAt = performance.now() || 1;
}

export function framePaintedAt(): number {
  return lastFrameAt;
}

export function resetFrameClock(): void {
  lastFrameAt = 0;
}

/**
 * Input has been forwarded that no painted pixel has answered yet.
 *
 * Lives here rather than in fallback.ts so that `markInput` — called from nine
 * places across input.ts and ime.ts — can set it without stats.ts and fallback.ts
 * importing each other. This module imports nothing, which is the whole point of it.
 */
let repaintOwed = false;

export function noteRepaintOwed(): void {
  repaintOwed = true;
}

export function repaintIsOwed(): boolean {
  return repaintOwed;
}

export function clearRepaintOwed(): void {
  repaintOwed = false;
}

export function remoteW(): number {
  return remoteWidth;
}

export function remoteH(): number {
  return remoteHeight;
}

/** A zero from a frame header means "unchanged", so it never overwrites a known size. */
export function setRemoteSize(w: number, h: number): void {
  remoteWidth = w || remoteWidth;
  remoteHeight = h || remoteHeight;
}
