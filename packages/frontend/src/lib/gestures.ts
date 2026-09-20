/**
 * Touch gesture recognition for the phone shell.
 *
 * Pure arithmetic, deliberately: the hard part of a swipe is not listening for touches,
 * it is deciding when a drag stopped being a scroll and became a gesture. That decision
 * is a function of two numbers, so it lives here where a test can ask it directly
 * instead of synthesising TouchEvents.
 *
 * The shell recognises gestures two different ways, and the difference is the iframe
 * boundary. Touches on shell DOM — a card's title bar, the desktop grid, the palette
 * handle — reach a `document` listener, so the top and bottom gestures need no overlay
 * and steal nothing: they only `preventDefault` once they have actually fired. Touches
 * inside an app iframe reach nothing at all, which is why the left/right monitor swipe
 * is the one gesture that needs a real element over the page (`EDGE_GUTTER_PX` wide) to
 * catch them.
 */

/** How far in from the left/right screen edge a monitor swipe has to start. */
export const EDGE_GUTTER_PX = 20;

/**
 * How far down from the top a pull-down has to start to mean "open the shade".
 * Sized to clear a card's 44px title bar plus the status notch, so the gesture is
 * available over the title bar without the title bar's buttons losing their taps.
 */
export const TOP_EDGE_PX = 72;

/** Travel before a drag counts as a swipe rather than a tap that wandered. */
export const SWIPE_MIN_PX = 56;

/**
 * How much one axis has to beat the other. A finger arcs; a horizontal swipe that
 * drifts 30px vertically is still horizontal, but a 45° drag is nobody's intent and
 * is better ignored than guessed at.
 */
export const SWIPE_AXIS_RATIO = 1.4;

export type SwipeDirection = 'left' | 'right' | 'up' | 'down';

export interface SwipeOptions {
  /** Minimum travel along the winning axis. Defaults to `SWIPE_MIN_PX`. */
  minDistance?: number;
  /** How far the winning axis must beat the other. Defaults to `SWIPE_AXIS_RATIO`. */
  axisRatio?: number;
}

/**
 * Which way this drag went, or `null` if it went nowhere in particular.
 *
 * `dy` is screen-space: positive is downward, the direction a pull-down travels.
 */
export function swipeDirection(
  dx: number,
  dy: number,
  { minDistance = SWIPE_MIN_PX, axisRatio = SWIPE_AXIS_RATIO }: SwipeOptions = {},
): SwipeDirection | null {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax >= minDistance && ax >= ay * axisRatio) return dx > 0 ? 'right' : 'left';
  if (ay >= minDistance && ay >= ax * axisRatio) return dy > 0 ? 'down' : 'up';
  return null;
}

/**
 * The index a monitor swipe lands on, or `null` when there is nowhere to go.
 *
 * Clamped rather than wrapped. With two monitors a wrap makes "next" and "previous"
 * the same gesture, so the user can no longer tell which one they did — and the
 * `null` is what lets the caller leave the touch to the page instead of consuming
 * it for a switch that would not have happened.
 */
export function stepMonitorIndex(current: number, count: number, delta: number): number | null {
  if (count <= 1) return null;
  const next = current + delta;
  if (next < 0 || next >= count) return null;
  return next;
}

/**
 * Which gesture a touch starting at `(x, y)` is allowed to become.
 *
 * Answered from the start point alone, before any movement, because that is when the
 * shell has to decide whether to track the touch at all — and a gesture that could
 * start anywhere would have to fight every scrollable thing on the screen.
 */
export function edgeZone(
  x: number,
  y: number,
  viewportWidth: number,
): 'left' | 'right' | 'top' | null {
  if (y <= TOP_EDGE_PX) return 'top';
  if (x <= EDGE_GUTTER_PX) return 'left';
  if (x >= viewportWidth - EDGE_GUTTER_PX) return 'right';
  return null;
}
