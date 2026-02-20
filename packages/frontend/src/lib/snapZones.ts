/**
 * Snap-to-edge zone detection and bounds calculation.
 * Pure utility — no React or store dependencies.
 */
import type { WindowBounds } from '@yaar/shared';

export type SnapZone =
  | 'left'
  | 'right'
  | 'top'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right';

const EDGE_THRESHOLD = 8;
const TASKBAR_H = 36;

/**
 * Detect which snap zone the cursor is in, if any.
 * Corners take priority over edges.
 */
export function detectSnapZone(cursorX: number, cursorY: number): SnapZone | null {
  const vw = globalThis.innerWidth;
  const vh = globalThis.innerHeight;

  const nearLeft = cursorX <= EDGE_THRESHOLD;
  const nearRight = cursorX >= vw - EDGE_THRESHOLD;
  const nearTop = cursorY <= EDGE_THRESHOLD;
  const nearBottom = cursorY >= vh - TASKBAR_H - EDGE_THRESHOLD;

  // Corners first (higher priority)
  if (nearTop && nearLeft) return 'top-left';
  if (nearTop && nearRight) return 'top-right';
  if (nearBottom && nearLeft) return 'bottom-left';
  if (nearBottom && nearRight) return 'bottom-right';

  // Edges
  if (nearTop) return 'top';
  if (nearLeft) return 'left';
  if (nearRight) return 'right';

  return null;
}

/**
 * Compute pixel bounds for a snap zone.
 */
export function getSnapBounds(zone: SnapZone): WindowBounds {
  const vw = globalThis.innerWidth;
  const vh = globalThis.innerHeight;
  const usableH = vh - TASKBAR_H;
  const halfW = Math.round(vw / 2);
  const halfH = Math.round(usableH / 2);

  switch (zone) {
    case 'top':
      return { x: 0, y: 0, w: vw, h: usableH };
    case 'left':
      return { x: 0, y: 0, w: halfW, h: usableH };
    case 'right':
      return { x: halfW, y: 0, w: vw - halfW, h: usableH };
    case 'top-left':
      return { x: 0, y: 0, w: halfW, h: halfH };
    case 'top-right':
      return { x: halfW, y: 0, w: vw - halfW, h: halfH };
    case 'bottom-left':
      return { x: 0, y: halfH, w: halfW, h: usableH - halfH };
    case 'bottom-right':
      return { x: halfW, y: halfH, w: vw - halfW, h: usableH - halfH };
  }
}
