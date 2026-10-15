import { describe, it, expect } from 'bun:test';
import {
  isWindowContentData,
  isContentUpdateOperationValid,
  cascadeWindowBounds,
  nextCascadeBounds,
  fitWindowBounds,
} from '../actions.js';

// The per-renderer shape guards (table / iframe / component) are module-internal; they are
// exercised here through `isWindowContentData`, the one exported entry point that dispatches
// to them.
describe('Runtime Validation', () => {
  describe('table content shape', () => {
    it('accepts valid table data', () => {
      expect(isWindowContentData('table', { headers: ['A', 'B'], rows: [['1', '2']] })).toBe(true);
    });

    it('accepts empty table', () => {
      expect(isWindowContentData('table', { headers: [], rows: [] })).toBe(true);
    });

    it('rejects invalid inputs', () => {
      expect(isWindowContentData('table', null)).toBe(false);
      expect(isWindowContentData('table', 'string')).toBe(false);
      expect(isWindowContentData('table', { headers: [1], rows: [] })).toBe(false);
      expect(isWindowContentData('table', { headers: [], rows: [[1]] })).toBe(false);
    });
  });

  describe('iframe content shape', () => {
    it('accepts string URL', () => {
      expect(isWindowContentData('iframe', 'https://example.com')).toBe(true);
    });

    it('accepts object with url', () => {
      expect(isWindowContentData('iframe', { url: 'https://example.com' })).toBe(true);
      expect(
        isWindowContentData('iframe', { url: 'https://example.com', sandbox: 'allow-scripts' }),
      ).toBe(true);
    });

    it('rejects invalid inputs', () => {
      expect(isWindowContentData('iframe', null)).toBe(false);
      expect(isWindowContentData('iframe', 42)).toBe(false);
      expect(isWindowContentData('iframe', { url: 123 })).toBe(false);
    });
  });

  describe('component layout shape', () => {
    it('accepts valid layout', () => {
      expect(isWindowContentData('component', { components: [] })).toBe(true);
      expect(isWindowContentData('component', { components: [{ type: 'button' }] })).toBe(true);
    });

    it('rejects invalid inputs', () => {
      expect(isWindowContentData('component', null)).toBe(false);
      expect(isWindowContentData('component', {})).toBe(false);
      expect(isWindowContentData('component', { components: 'not-array' })).toBe(false);
    });
  });

  describe('isWindowContentData', () => {
    it('validates string renderers', () => {
      expect(isWindowContentData('markdown', '# Hello')).toBe(true);
      expect(isWindowContentData('html', '<p>Hi</p>')).toBe(true);
      expect(isWindowContentData('text', 'plain')).toBe(true);
      expect(isWindowContentData('markdown', 42)).toBe(false);
    });

    it('validates table renderer', () => {
      expect(isWindowContentData('table', { headers: ['A'], rows: [['1']] })).toBe(true);
      expect(isWindowContentData('table', 'not-table')).toBe(false);
    });

    it('validates iframe renderer', () => {
      expect(isWindowContentData('iframe', 'https://example.com')).toBe(true);
      expect(isWindowContentData('iframe', null)).toBe(false);
    });

    it('validates component renderer', () => {
      expect(isWindowContentData('component', { components: [] })).toBe(true);
      expect(isWindowContentData('component', 'string')).toBe(false);
    });

    it('unknown renderer accepts anything defined', () => {
      expect(isWindowContentData('custom', 'anything')).toBe(true);
      expect(isWindowContentData('custom', undefined)).toBe(false);
    });
  });

  describe('isContentUpdateOperationValid', () => {
    it('validates append/prepend for text renderers', () => {
      expect(isContentUpdateOperationValid('markdown', { op: 'append', data: 'more' })).toBe(true);
      expect(isContentUpdateOperationValid('html', { op: 'prepend', data: '<p>' })).toBe(true);
      expect(isContentUpdateOperationValid('table', { op: 'append', data: 'nope' })).toBe(false);
      expect(isContentUpdateOperationValid('markdown', { op: 'append', data: 42 })).toBe(false);
    });

    it('validates insertAt', () => {
      expect(
        isContentUpdateOperationValid('text', { op: 'insertAt', position: 5, data: 'x' }),
      ).toBe(true);
      expect(
        isContentUpdateOperationValid('text', { op: 'insertAt', position: Infinity, data: 'x' }),
      ).toBe(false);
    });

    it('validates replace', () => {
      expect(isContentUpdateOperationValid('markdown', { op: 'replace', data: 'new' })).toBe(true);
      expect(
        isContentUpdateOperationValid('table', { op: 'replace', data: { headers: [], rows: [] } }),
      ).toBe(true);
    });

    it('clear always valid', () => {
      expect(isContentUpdateOperationValid('markdown', { op: 'clear' })).toBe(true);
      expect(isContentUpdateOperationValid('table', { op: 'clear' })).toBe(true);
    });
  });
});

describe('nextCascadeBounds', () => {
  const viewport = { w: 1400, h: 900 };

  it('uses slot 0 when nothing is open', () => {
    expect(nextCascadeBounds([], 820, 600, viewport)).toEqual(
      cascadeWindowBounds(0, 820, 600, viewport),
    );
  });

  it('skips a slot still held by a survivor after an earlier window closed', () => {
    const slot1 = cascadeWindowBounds(1, 820, 600, viewport);
    // Slot 0 was closed; one window remains at slot 1, so count (1) would land on it.
    const next = nextCascadeBounds([slot1], 820, 600, viewport);
    expect(next).toEqual(cascadeWindowBounds(0, 820, 600, viewport));
    expect(next.x === slot1.x && next.y === slot1.y).toBe(false);
  });

  it('treats positions within a few px as occupied', () => {
    const slot0 = cascadeWindowBounds(0, 820, 600, viewport);
    const next = nextCascadeBounds([{ x: slot0.x + 2, y: slot0.y - 3 }], 820, 600, viewport);
    expect(next).toEqual(cascadeWindowBounds(1, 820, 600, viewport));
  });

  it('cycles by count when every slot is taken', () => {
    const occupied = Array.from({ length: 10 }, (_, i) =>
      cascadeWindowBounds(i, 820, 600, viewport),
    );
    expect(nextCascadeBounds(occupied, 820, 600, viewport)).toEqual(
      cascadeWindowBounds(10, 820, 600, viewport),
    );
  });
});

describe('fitWindowBounds', () => {
  const desktop = { x: 0, y: 0, w: 1600, h: 900 };

  it('leaves a window that already fits alone', () => {
    const b = { x: 100, y: 80, w: 800, h: 600 };
    expect(fitWindowBounds(b, desktop)).toEqual(b);
  });

  it('moves an overflowing window left before it would narrow it (#182)', () => {
    // The reported case: 1400px wide at x=306 on a 1600px desktop.
    expect(fitWindowBounds({ x: 306, y: 40, w: 1400, h: 700 }, desktop)).toEqual({
      x: 200,
      y: 40,
      w: 1400,
      h: 700,
    });
  });

  it('moves an overflowing window up before it would shorten it', () => {
    expect(fitWindowBounds({ x: 0, y: 500, w: 400, h: 600 }, desktop)).toEqual({
      x: 0,
      y: 300,
      w: 400,
      h: 600,
    });
  });

  it('shrinks only a window larger than the area, pinned to its origin', () => {
    expect(fitWindowBounds({ x: 50, y: 50, w: 2000, h: 1200 }, desktop)).toEqual({
      x: 0,
      y: 0,
      w: 1600,
      h: 900,
    });
  });

  it('pulls a window back from a negative origin', () => {
    expect(fitWindowBounds({ x: -300, y: -20, w: 400, h: 300 }, desktop)).toEqual({
      x: 0,
      y: 0,
      w: 400,
      h: 300,
    });
  });

  it('respects an area that does not start at the origin', () => {
    const area = { x: 0, y: 52, w: 1600, h: 721 };
    expect(fitWindowBounds({ x: 10, y: 0, w: 400, h: 300 }, area)).toEqual({
      x: 10,
      y: 52,
      w: 400,
      h: 300,
    });
  });

  it('returns the bounds unchanged for an empty area', () => {
    const b = { x: 10, y: 10, w: 400, h: 300 };
    expect(fitWindowBounds(b, { x: 0, y: 0, w: 0, h: 0 })).toEqual(b);
  });
});
