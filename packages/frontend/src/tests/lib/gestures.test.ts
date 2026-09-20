/**
 * The phone gesture recogniser. The question these answer is not "does a swipe work"
 * but "does a drag that was not a swipe stay out of the way" — a gesture layer that
 * guesses eats taps and scrolls, which is worse than having no gestures at all.
 */
import { describe, it, expect } from 'bun:test';
import {
  EDGE_GUTTER_PX,
  SWIPE_MIN_PX,
  TOP_EDGE_PX,
  edgeZone,
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

describe('edgeZone', () => {
  const width = 400;

  it('claims the top band, both side gutters, and nothing else', () => {
    expect(edgeZone(200, 10, width)).toBe('top');
    expect(edgeZone(2, 300, width)).toBe('left');
    expect(edgeZone(width - 2, 300, width)).toBe('right');
    expect(edgeZone(200, 300, width)).toBeNull();
  });

  it('gives the top band the corner: a pull from there is a pull-down', () => {
    expect(edgeZone(2, 10, width)).toBe('top');
  });

  it('stops exactly where the constants say', () => {
    expect(edgeZone(EDGE_GUTTER_PX, 300, width)).toBe('left');
    expect(edgeZone(EDGE_GUTTER_PX + 1, 300, width)).toBeNull();
    expect(edgeZone(200, TOP_EDGE_PX, width)).toBe('top');
    expect(edgeZone(200, TOP_EDGE_PX + 1, width)).toBeNull();
  });
});
