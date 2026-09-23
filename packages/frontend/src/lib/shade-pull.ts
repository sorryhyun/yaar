/**
 * The phone shade's pull, written down once so both ends of it agree.
 *
 * The shade is pulled open by a downward drag and pushed shut again by its own grip —
 * the same gesture from opposite ends, but owned by two different components:
 * `PhoneGestures` has the `document` listeners the desktop's touches reach, and
 * `NotificationShade` has the grip, which is its own DOM. Rather than have each of them
 * animate the sheet its own way, both write these custom properties onto the sheet and its
 * backdrop (through `lib/gesture-layer`, never onto `<html>` — see there for why) and let
 * one rule in `NotificationShade.module.css` place it. The phase is on `<html>`.
 *
 * Writing to the DOM node instead of through React is the same choice the monitor pan
 * makes: a pull re-renders the shade once, when it mounts, and never again per frame.
 *
 * Neither end has to know how tall the sheet is. `--shade-pull` is how much of it the
 * finger has brought down, and the CSS clamps at `min(0px, -100% + var(--shade-pull))`,
 * where `-100%` is whatever the sheet turned out to be — so the pull is still correct
 * on a shade with ten notifications in it and on one with none.
 *
 * A second pull on the open sheet — the one that clears the context — has its own phase
 * (`data-shade-clear`) and its own stretch (`--shade-overpull`); see `trackShadeClear`.
 */
import { SHADE_CLEAR_HOLD_MS, SHADE_SETTLE_MS, shadeDim, shadeOverpull } from './gestures';
import { clearGestureVars, setGestureVar } from './gesture-layer';

const LAYER = 'shade-pull';

/** Which phase the pull is in: following a finger, or finishing without one. */
const PULL_STATE_ATTR = 'data-shade-pull';
/** How far down the sheet has been brought, in px from parked. */
const PULL_VAR = '--shade-pull';
/** How dark the desktop behind it is, 0 to 1. */
const DIM_VAR = '--shade-dim';
/** Published beside them so the settle transition and the settle timer cannot disagree. */
const PULL_MS_VAR = '--shade-pull-ms';

/**
 * The second pull's phase: `dragging`, `armed` (see `shadeClearArmed`), `cleared` (held
 * after a pull that cleared, see `holdShadeClear`), or `settling`.
 */
const CLEAR_STATE_ATTR = 'data-shade-clear';
/** How far the open sheet has been stretched down by that second pull. */
const OVERPULL_VAR = '--shade-overpull';

/** Past any plausible sheet height: the CSS clamp turns it into "all the way open". */
const FULLY_OPEN = '100vh';

/** Follow the finger: `y` px of the sheet are on screen. */
export function trackShadePull(y: number): void {
  const root = document.documentElement;
  const clamped = Math.max(0, y);
  if (root.dataset.shadePull !== 'dragging') {
    root.dataset.shadePull = 'dragging';
    setGestureVar(LAYER, PULL_MS_VAR, `${SHADE_SETTLE_MS}ms`);
  }
  setGestureVar(LAYER, PULL_VAR, `${clamped}px`);
  setGestureVar(LAYER, DIM_VAR, `${shadeDim(clamped)}`);
}

/**
 * Let go: run the rest of the slide, then tell the caller where it landed.
 *
 * `done` fires once the sheet has arrived, which is when a shade that lost the pull can
 * be unmounted — do it any earlier and the closing half of the animation is a sheet
 * that vanished. The returned handle is for a caller that goes away mid-settle.
 */
export function settleShadePull(open: boolean, done: () => void): ReturnType<typeof setTimeout> {
  const root = document.documentElement;
  root.dataset.shadePull = 'settling';
  setGestureVar(LAYER, PULL_MS_VAR, `${SHADE_SETTLE_MS}ms`);
  setGestureVar(LAYER, PULL_VAR, open ? FULLY_OPEN : '0px');
  setGestureVar(LAYER, DIM_VAR, open ? '1' : '0');
  return setTimeout(() => {
    // A shade that stays open keeps the properties: dropping them here would hand the
    // sheet back to its entry keyframes, which would play the slide a second time.
    if (open) root.dataset.shadePull = 'open';
    done();
  }, SHADE_SETTLE_MS);
}

/**
 * A second pull on a shade that is already open: stretch the sheet down, and show
 * whether letting go now would clear the context — `armed`, which the caller decides
 * (`shadeClearArmed`), because it depends on where the pull has been, not just where it is.
 *
 * Its own phase attribute rather than a fourth value of `data-shade-pull`, because the
 * sheet is still open underneath it — a settle that went wrong halfway must leave an open
 * shade behind, not one parked wherever the first pull's properties last said.
 */
export function trackShadeClear(dy: number, armed: boolean): void {
  const root = document.documentElement;
  // A shade that was opened without a drag (a flick coalesced to start and end) is still
  // on its entry animation's terms. Put it on the pull's before this rule takes the
  // animation away, or handing it back afterwards would play the slide-down again.
  if (!root.dataset.shadePull) {
    root.dataset.shadePull = 'open';
    setGestureVar(LAYER, PULL_VAR, FULLY_OPEN);
    setGestureVar(LAYER, DIM_VAR, '1');
  }
  root.setAttribute(CLEAR_STATE_ATTR, armed ? 'armed' : 'dragging');
  setGestureVar(LAYER, PULL_MS_VAR, `${SHADE_SETTLE_MS}ms`);
  setGestureVar(LAYER, OVERPULL_VAR, `${shadeOverpull(dy)}px`);
}

/**
 * A second pull that cleared: keep the sheet stretched where the finger left it and say
 * so (`cleared`) for `SHADE_CLEAR_HOLD_MS`, then spring it back through
 * {@link settleShadeClear}. The handle is the one that is live at the time — the hold's,
 * then the settle's — through `onTimer`, so a caller that goes away mid-way can cancel.
 */
export function holdShadeClear(
  done: () => void,
  onTimer: (timer: ReturnType<typeof setTimeout>) => void,
): void {
  document.documentElement.setAttribute(CLEAR_STATE_ATTR, 'cleared');
  onTimer(setTimeout(() => onTimer(settleShadeClear(done)), SHADE_CLEAR_HOLD_MS));
}

/** Let go of a second pull: spring the sheet back to open, then hand over. */
export function settleShadeClear(done: () => void): ReturnType<typeof setTimeout> {
  const root = document.documentElement;
  root.setAttribute(CLEAR_STATE_ATTR, 'settling');
  setGestureVar(LAYER, OVERPULL_VAR, '0px');
  return setTimeout(() => {
    root.removeAttribute(CLEAR_STATE_ATTR);
    done();
  }, SHADE_SETTLE_MS);
}

/** Give the sheet back to CSS. The shade calls this as it unmounts. */
export function clearShadePull(): void {
  document.documentElement.removeAttribute(PULL_STATE_ATTR);
  document.documentElement.removeAttribute(CLEAR_STATE_ATTR);
  clearGestureVars(LAYER);
}
