/**
 * The phone shade's pull, written down once so both ends of it agree.
 *
 * The shade is dragged open from the top edge and pushed shut again by its own grip —
 * the same gesture from opposite ends, but owned by two different components:
 * `PhoneGestures` has the `document` listeners the desktop's touches reach, and
 * `NotificationShade` has the grip, which is its own DOM. Rather than have each of them
 * animate the sheet its own way, both write these custom properties on `<html>` and let
 * one rule in `NotificationShade.module.css` place it.
 *
 * Writing to the DOM node instead of through React is the same choice the monitor pan
 * makes: a pull re-renders the shade once, when it mounts, and never again per frame.
 *
 * Neither end has to know how tall the sheet is. `--shade-pull` is how much of it the
 * finger has brought down, and the CSS clamps at `min(0px, -100% + var(--shade-pull))`,
 * where `-100%` is whatever the sheet turned out to be — so the pull is still correct
 * on a shade with ten notifications in it and on one with none.
 */
import { SHADE_SETTLE_MS, shadeDim } from './gestures';

/** Which phase the pull is in: following a finger, or finishing without one. */
const PULL_STATE_ATTR = 'data-shade-pull';
/** How far down the sheet has been brought, in px from parked. */
const PULL_VAR = '--shade-pull';
/** How dark the desktop behind it is, 0 to 1. */
const DIM_VAR = '--shade-dim';
/** Published beside them so the settle transition and the settle timer cannot disagree. */
const PULL_MS_VAR = '--shade-pull-ms';

/** Past any plausible sheet height: the CSS clamp turns it into "all the way open". */
const FULLY_OPEN = '100vh';

/** Follow the finger: `y` px of the sheet are on screen. */
export function trackShadePull(y: number): void {
  const root = document.documentElement;
  const clamped = Math.max(0, y);
  if (root.dataset.shadePull !== 'dragging') {
    root.dataset.shadePull = 'dragging';
    root.style.setProperty(PULL_MS_VAR, `${SHADE_SETTLE_MS}ms`);
  }
  root.style.setProperty(PULL_VAR, `${clamped}px`);
  root.style.setProperty(DIM_VAR, `${shadeDim(clamped)}`);
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
  root.style.setProperty(PULL_MS_VAR, `${SHADE_SETTLE_MS}ms`);
  root.style.setProperty(PULL_VAR, open ? FULLY_OPEN : '0px');
  root.style.setProperty(DIM_VAR, open ? '1' : '0');
  return setTimeout(() => {
    // A shade that stays open keeps the properties: dropping them here would hand the
    // sheet back to its entry keyframes, which would play the slide a second time.
    if (open) root.dataset.shadePull = 'open';
    done();
  }, SHADE_SETTLE_MS);
}

/** Give the sheet back to CSS. The shade calls this as it unmounts. */
export function clearShadePull(): void {
  const root = document.documentElement;
  root.removeAttribute(PULL_STATE_ATTR);
  root.style.removeProperty(PULL_VAR);
  root.style.removeProperty(DIM_VAR);
  root.style.removeProperty(PULL_MS_VAR);
}
