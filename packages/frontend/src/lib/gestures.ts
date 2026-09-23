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
 * handle — reach a `document` listener, so those gestures need no overlay and steal
 * nothing: they only `preventDefault` once they have actually fired. Touches inside an
 * app iframe reach nothing at all, which is why the monitor pan also keeps a real
 * element over the page (`EDGE_GUTTER_PX` wide at each side edge) to catch them.
 *
 * A drag that the shell follows is two questions, not one, and they are asked at
 * different moments. `dragAxis` runs while the finger is still down and decides whether
 * the shell is following it — early, because a peek that starts late looks like a
 * stutter. `shouldCommitDrag` runs when the finger lifts and decides where it lands.
 * Both the monitor pan and the shade pull ask them, in that order.
 */

/** How far in from the left/right screen edge a monitor swipe has to start. */
export const EDGE_GUTTER_PX = 20;

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
 * Travel before a drag has to say which axis it is on.
 *
 * Much smaller than `SWIPE_MIN_PX`, because this is a different question. `SWIPE_MIN_PX`
 * asks "was that a swipe?" once the finger is up; this asks "is the desktop following
 * this finger?" while it is still down, and the answer has to come early enough that the
 * peek looks like it was there from the first pixel.
 */
export const DRAG_INTENT_PX = 10;

/**
 * How far the horizontal axis has to beat the vertical one to claim an undecided drag.
 *
 * Lower than `SWIPE_AXIS_RATIO`: at 10px of travel a finger has barely committed to
 * anything, and the tie goes to vertical — an unwanted page scroll is a smaller mistake
 * than a monitor that slides away under a finger that meant to scroll.
 */
export const DRAG_AXIS_RATIO = 1.2;

/** Resistance applied to a drag that has no monitor to uncover. */
export const RUBBER_BAND_DIVISOR = 4;

/** Speed, in px/ms, at which a short drag still counts as a flick. */
export const FLICK_VELOCITY = 0.5;

/** How long the desktop takes to settle onto a monitor after the finger lifts. */
export const PEEK_SETTLE_MS = 220;

/** At most this many window titles are named on the monitor being peeked at. */
export const PEEK_TITLE_LIMIT = 3;

/**
 * Which axis an in-flight drag has committed to, or `null` while it is still undecided.
 *
 * Once decided it stays decided — the caller locks it — because a finger arcs, and a
 * pan that re-evaluated every frame would hand the drag back to the page halfway
 * through a swipe that was going fine.
 */
export function dragAxis(dx: number, dy: number): 'x' | 'y' | null {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax >= DRAG_INTENT_PX && ax >= ay * DRAG_AXIS_RATIO) return 'x';
  if (ay >= DRAG_INTENT_PX) return 'y';
  return null;
}

/**
 * How far the desktop is dragged aside for a finger that has travelled `dx`.
 *
 * One-to-one when there is a monitor to uncover: the screen is the thing being dragged,
 * so it has to stay under the finger or the gesture stops reading as direct manipulation.
 * When there is nothing over there it is divided down instead of clamped flat, which is
 * the difference between an edge that says "no" and one that says nothing at all.
 */
export function peekOffset(dx: number, hasNeighbour: boolean, viewportWidth: number): number {
  const limit = Math.max(0, viewportWidth) / (hasNeighbour ? 1 : RUBBER_BAND_DIVISOR);
  const travel = hasNeighbour ? dx : dx / RUBBER_BAND_DIVISOR;
  return Math.max(-limit, Math.min(limit, travel));
}

/**
 * Whether a finished drag lands where it was heading or falls back.
 *
 * Distance *or* speed: a slow deliberate drag is read from how far it went, and a flick
 * from how fast — insisting on `SWIPE_MIN_PX` for both would make the quickest version
 * of the gesture the one that does not work.
 *
 * Axis-agnostic, because the question is the same one at both ends of the shell: the
 * monitor pan asks it of `dx` and the shade pull of `dy`, and a phone where a flick
 * opened the shade but not the neighbouring monitor would just feel inconsistent.
 */
export function shouldCommitDrag(travel: number, elapsedMs: number): boolean {
  const distance = Math.abs(travel);
  if (distance >= SWIPE_MIN_PX) return true;
  return distance >= DRAG_INTENT_PX && elapsedMs > 0 && distance / elapsedMs >= FLICK_VELOCITY;
}

/** How long the shade takes to finish the pull once the finger lifts. */
export const SHADE_SETTLE_MS = 200;

/**
 * How far a pull has to travel before the screen behind the shade is fully dimmed.
 *
 * Shorter than the sheet is tall, on purpose: the dim is what says the shade is a layer
 * over the desktop rather than part of it, and it reads as that from the first
 * centimetre. It is not trying to be a percentage of anything.
 */
export const SHADE_DIM_PX = 180;

/** How dark the screen behind a shade pulled down by `y` is, 0 to 1. */
export function shadeDim(y: number): number {
  return Math.max(0, Math.min(1, y / SHADE_DIM_PX));
}

/**
 * How far a second pull on an already-open shade has to travel to clear the context.
 *
 * Well past `SWIPE_MIN_PX`: the first pull is navigation and costs nothing to get wrong,
 * this one throws away the monitor's windows and conversation. A drag that has to be
 * *meant* is the gesture's own confirmation — the hint flips to "release" at this point,
 * and a finger that sees that and changes its mind slides back up before lifting.
 */
export const SHADE_CLEAR_PX = 160;

/**
 * How far a second pull may come back up from the deepest point it reached and still
 * clear. A finger held still wobbles a few pixels; one that has come back further than
 * this is taking the pull back, and letting go then must not clear anything — the reset
 * is armed only while the finger is still pulling *down*.
 */
export const SHADE_CLEAR_RETREAT_PX = 12;

/**
 * Whether letting go of a second pull now would clear the context: far enough down, and
 * not on its way back up. `peak` is the deepest `dy` the pull has reached.
 */
export function shadeClearArmed(dy: number, peak: number): boolean {
  return dy >= SHADE_CLEAR_PX && peak - dy <= SHADE_CLEAR_RETREAT_PX;
}

/**
 * How long a second pull that did clear stays stretched before springing back.
 *
 * The reset is sent the moment the finger lifts, and a sheet that sprang straight back
 * and closed looked the same as one that had been let go short — the toast arrives
 * after the eye has already moved on. Held open on "Context cleared" for this long, the
 * gesture itself says it worked.
 */
export const SHADE_CLEAR_HOLD_MS = 300;

/** The most the sheet itself travels on that second pull, however far the finger goes. */
export const SHADE_OVERPULL_MAX_PX = 110;

/**
 * How far an open shade is dragged down by a finger that has travelled `dy` past it.
 *
 * Half-speed and capped: the sheet is already all the way open, so this is the stretch
 * of pull-to-refresh rather than a surface following the finger — it says "there is
 * something more down here" without pretending the sheet has somewhere to go.
 */
export function shadeOverpull(dy: number): number {
  return Math.min(SHADE_OVERPULL_MAX_PX, Math.max(0, dy) / 2);
}
