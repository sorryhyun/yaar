/**
 * The phone gesture recogniser. The question these answer is not "does a swipe work"
 * but "does a drag that was not a swipe stay out of the way" — a gesture layer that
 * guesses eats taps and scrolls, which is worse than having no gestures at all.
 */
import { describe, it, expect } from 'bun:test';
import {
  DRAG_INTENT_PX,
  FLICK_VELOCITY,
  PALETTE_FLICK_MIN_PX,
  PALETTE_RAISE_PX,
  RUBBER_BAND_DIVISOR,
  SHADE_CLEAR_PX,
  SHADE_CLEAR_RETREAT_PX,
  SHADE_DIM_PX,
  SHADE_OVERPULL_MAX_PX,
  SWIPE_MIN_PX,
  dragAxis,
  peekOffset,
  shadeClearArmed,
  shadeDim,
  shadeOverpull,
  shouldCommitDrag,
  shouldRaisePalette,
  stepMonitorIndex,
  swipeDirection,
} from '../../lib/gestures';

describe('swipeDirection', () => {
  it('names the axis the drag actually travelled', () => {
    expect(swipeDirection(120, 0)).toBe('right');
    expect(swipeDirection(-120, 0)).toBe('left');
    expect(swipeDirection(0, 120)).toBe('down');
    expect(swipeDirection(0, -120)).toBe('up');
  });

  it('ignores a drag that did not go far enough to be meant', () => {
    expect(swipeDirection(SWIPE_MIN_PX - 1, 0)).toBeNull();
    expect(swipeDirection(0, SWIPE_MIN_PX - 1)).toBeNull();
    expect(swipeDirection(SWIPE_MIN_PX, 0)).toBe('right');
  });

  it('tolerates the arc a finger makes but not a diagonal', () => {
    // 120px across, 30px of drift: still a horizontal swipe.
    expect(swipeDirection(120, 30)).toBe('right');
    // 45°: nobody's intent, and guessing is worse than doing nothing.
    expect(swipeDirection(100, 100)).toBeNull();
  });

  it('takes its thresholds from the caller when asked', () => {
    expect(swipeDirection(30, 0)).toBeNull();
    expect(swipeDirection(30, 0, { minDistance: 20 })).toBe('right');
  });
});

describe('stepMonitorIndex', () => {
  it('walks the list', () => {
    expect(stepMonitorIndex(0, 3, 1)).toBe(1);
    expect(stepMonitorIndex(2, 3, -1)).toBe(1);
  });

  it('clamps instead of wrapping, so the two directions stay distinguishable', () => {
    expect(stepMonitorIndex(0, 3, -1)).toBeNull();
    expect(stepMonitorIndex(2, 3, 1)).toBeNull();
  });

  it('has nowhere to go with a single monitor', () => {
    expect(stepMonitorIndex(0, 1, 1)).toBeNull();
    expect(stepMonitorIndex(0, 1, -1)).toBeNull();
  });
});

describe('dragAxis', () => {
  it('says nothing until the finger has committed to something', () => {
    expect(dragAxis(0, 0)).toBeNull();
    expect(dragAxis(DRAG_INTENT_PX - 1, 0)).toBeNull();
    expect(dragAxis(0, DRAG_INTENT_PX - 1)).toBeNull();
  });

  it('decides far sooner than swipeDirection would', () => {
    // The pan starts following the finger here; whether it *lands* is a later question.
    expect(dragAxis(DRAG_INTENT_PX, 0)).toBe('x');
    expect(swipeDirection(DRAG_INTENT_PX, 0)).toBeNull();
  });

  it('gives a drag that is going both ways to the page', () => {
    // A 45-degree drag is more likely a scroll that drifted than a pan that is late,
    // and a wrong scroll is a smaller mistake than a monitor sliding away.
    expect(dragAxis(40, 40)).toBe('y');
    expect(dragAxis(40, 20)).toBe('x');
  });
});

describe('peekOffset', () => {
  const width = 400;

  it('keeps the desktop under the finger when there is somewhere to go', () => {
    expect(peekOffset(-80, true, width)).toBe(-80);
    expect(peekOffset(80, true, width)).toBe(80);
  });

  it('never drags it further than one screen', () => {
    expect(peekOffset(width * 3, true, width)).toBe(width);
    expect(peekOffset(-width * 3, true, width)).toBe(-width);
  });

  it('resists instead of refusing at the end of the list', () => {
    // Not clamped flat: an edge that moves a little says "nothing over there", and an
    // edge that does not move at all says nothing at all.
    expect(peekOffset(80, false, width)).toBe(80 / RUBBER_BAND_DIVISOR);
    expect(peekOffset(width * 3, false, width)).toBe(width / RUBBER_BAND_DIVISOR);
  });
});

describe('shouldCommitDrag', () => {
  it('reads a vertical pull by the same rule as a sideways pan', () => {
    // One rule, both axes: a flick that opens the shade but would not have changed
    // monitors is the kind of inconsistency a thumb notices and cannot name.
    expect(shouldCommitDrag(SWIPE_MIN_PX, 4000)).toBe(shouldCommitDrag(-SWIPE_MIN_PX, 4000));
  });

  it('lands a drag that went far enough, however long it took', () => {
    expect(shouldCommitDrag(SWIPE_MIN_PX, 4000)).toBe(true);
    expect(shouldCommitDrag(-SWIPE_MIN_PX, 4000)).toBe(true);
  });

  it('lands a short one that was fast enough', () => {
    const dx = SWIPE_MIN_PX / 2;
    expect(shouldCommitDrag(dx, dx / FLICK_VELOCITY - 1)).toBe(true);
    expect(shouldCommitDrag(dx, dx / FLICK_VELOCITY + 1)).toBe(false);
  });

  it('never reads a nudge as a flick, however quick', () => {
    expect(shouldCommitDrag(DRAG_INTENT_PX - 1, 1)).toBe(false);
  });
});

describe('shouldRaisePalette', () => {
  it('asks more of a pull up than the rest of the shell asks of a drag', () => {
    // A scroll that hit the bottom of its list is a pull up too; landing one puts the
    // keyboard over whatever was being read, so the bar sits above `SWIPE_MIN_PX`.
    expect(PALETTE_RAISE_PX).toBeGreaterThan(SWIPE_MIN_PX);
    expect(shouldRaisePalette(SWIPE_MIN_PX, 4000)).toBe(false);
    expect(shouldRaisePalette(PALETTE_RAISE_PX, 4000)).toBe(true);
  });

  it('raises on a real flick, but not on the nudge the end of a scroll gives', () => {
    expect(shouldRaisePalette(PALETTE_FLICK_MIN_PX, 1)).toBe(true);
    expect(
      shouldRaisePalette(PALETTE_FLICK_MIN_PX, PALETTE_FLICK_MIN_PX / FLICK_VELOCITY + 1),
    ).toBe(false);
    // Fast enough for `shouldCommitDrag`, and still not a raise.
    expect(shouldCommitDrag(DRAG_INTENT_PX + 2, 1)).toBe(true);
    expect(shouldRaisePalette(DRAG_INTENT_PX + 2, 1)).toBe(false);
  });

  it('never raises on a pull that ended up going down', () => {
    expect(shouldRaisePalette(-PALETTE_RAISE_PX, 1)).toBe(false);
  });
});

describe('shadeDim', () => {
  it('darkens with the pull and stops at full', () => {
    expect(shadeDim(0)).toBe(0);
    expect(shadeDim(SHADE_DIM_PX / 2)).toBe(0.5);
    expect(shadeDim(SHADE_DIM_PX * 3)).toBe(1);
  });

  it('is nothing at all for a pull that has gone backwards', () => {
    // The grip drag measures from however much of the sheet was already down, so a
    // finger that overshoots upward asks for a negative one.
    expect(shadeDim(-40)).toBe(0);
  });
});

describe('shadeOverpull', () => {
  it('stretches an open shade at half the finger, and no further than its cap', () => {
    expect(shadeOverpull(-40)).toBe(0);
    expect(shadeOverpull(60)).toBe(30);
    expect(shadeOverpull(10_000)).toBe(SHADE_OVERPULL_MAX_PX);
  });

  it('arms before the stretch runs out, so the hint says "release" while it still moves', () => {
    expect(shadeOverpull(SHADE_CLEAR_PX)).toBeLessThan(SHADE_OVERPULL_MAX_PX);
  });
});

describe('shadeClearArmed', () => {
  it('arms past the line while the pull is still going down', () => {
    expect(shadeClearArmed(SHADE_CLEAR_PX - 1, SHADE_CLEAR_PX - 1)).toBe(false);
    expect(shadeClearArmed(SHADE_CLEAR_PX, SHADE_CLEAR_PX)).toBe(true);
  });

  it('disarms a pull on its way back up, before it is back above the line', () => {
    const peak = SHADE_CLEAR_PX + 80;
    expect(shadeClearArmed(peak - SHADE_CLEAR_RETREAT_PX, peak)).toBe(true);
    expect(shadeClearArmed(peak - SHADE_CLEAR_RETREAT_PX - 1, peak)).toBe(false);
  });
});
