/**
 * `computeWindowStyle` — the position/size branch WindowFrame used to compute inline.
 * Pure, so covered directly rather than through a render; precedence between the modes
 * (a card ignoring maximize, a custom `windowStyle` still respecting the panel z-index)
 * is what actually matters here.
 */
import { describe, expect, it } from 'bun:test';
import type { WindowModel } from '@/types/state';
import { computeWindowStyle } from '@/components/window/windowStyle';

function makeWindow(overrides: Partial<WindowModel> = {}): WindowModel {
  return {
    id: 'w1',
    title: 'Test',
    bounds: { x: 10, y: 20, w: 300, h: 200 },
    content: { renderer: 'markdown', data: '' },
    minimized: false,
    maximized: false,
    ...overrides,
  };
}

const baseFlags = { isCard: false, isFullscreen: false, isPanel: false, isWidget: false };

describe('computeWindowStyle', () => {
  it('card: fills the screen above the palette', () => {
    const style = computeWindowStyle({
      window: makeWindow(),
      zIndex: 5,
      ...baseFlags,
      isCard: true,
    });
    expect(style).toEqual({
      top: 0,
      left: 0,
      width: '100%',
      height: 'calc(100% - var(--palette-h, 0px))',
      zIndex: 105,
    });
  });

  it('fullscreen card: covers the palette too', () => {
    const style = computeWindowStyle({
      window: makeWindow(),
      zIndex: 5,
      ...baseFlags,
      isCard: true,
      isFullscreen: true,
    });
    expect(style.height).toBe('100%');
    expect(style.zIndex).toBe(105);
  });

  it('card precedence beats maximized — a maximized card is still a full card, not the desktop-maximize style', () => {
    const style = computeWindowStyle({
      window: makeWindow({ maximized: true }),
      zIndex: 5,
      ...baseFlags,
      isCard: true,
    });
    expect(style.height).toBe('calc(100% - var(--palette-h, 0px))');
  });

  it('custom windowStyle: positions from bounds, spreads the override last, and sits below a panel z-index', () => {
    const style = computeWindowStyle({
      window: makeWindow({ windowStyle: { top: '50%', borderRadius: '8px' } }),
      zIndex: 3,
      ...baseFlags,
    });
    expect(style).toEqual({
      top: '50%', // overridden by the spread, not the bounds-derived 20
      left: 10,
      width: 300,
      height: 200,
      zIndex: 103,
      borderRadius: '8px',
    });
  });

  it('custom windowStyle + panel: z-index is the fixed panel value, not zIndex + 100', () => {
    const style = computeWindowStyle({
      window: makeWindow({ windowStyle: {} }),
      zIndex: 3,
      ...baseFlags,
      isPanel: true,
    });
    expect(style.zIndex).toBe(9000);
  });

  it('panel: fixed to the bottom edge by default', () => {
    const style = computeWindowStyle({
      window: makeWindow(),
      zIndex: 3,
      ...baseFlags,
      isPanel: true,
    });
    expect(style).toEqual({
      position: 'fixed',
      left: 0,
      width: '100%',
      height: 200,
      zIndex: 9000,
      bottom: 0,
    });
  });

  it('panel: docks to the top edge when requested', () => {
    const style = computeWindowStyle({
      window: makeWindow({ dockEdge: 'top' }),
      zIndex: 3,
      ...baseFlags,
      isPanel: true,
    });
    expect(style.top).toBe(0);
    expect(style.bottom).toBeUndefined();
  });

  it('panel precedence beats maximized', () => {
    const style = computeWindowStyle({
      window: makeWindow({ maximized: true }),
      zIndex: 3,
      ...baseFlags,
      isPanel: true,
    });
    expect(style.position).toBe('fixed');
  });

  it('maximized: fills the screen at zIndex + 100', () => {
    const style = computeWindowStyle({
      window: makeWindow({ maximized: true }),
      zIndex: 7,
      ...baseFlags,
    });
    expect(style).toEqual({
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      zIndex: 107,
    });
  });

  it('maximized precedence beats widget — a maximized widget still fills the screen', () => {
    const style = computeWindowStyle({
      window: makeWindow({ maximized: true }),
      zIndex: 7,
      ...baseFlags,
      isWidget: true,
    });
    expect(style.width).toBe('100%');
  });

  it('widget: positions from bounds with no zIndex + 100 offset', () => {
    const style = computeWindowStyle({
      window: makeWindow(),
      zIndex: 4,
      ...baseFlags,
      isWidget: true,
    });
    expect(style).toEqual({
      top: 20,
      left: 10,
      width: 300,
      height: 200,
      zIndex: 4,
    });
  });

  it('default: standard window positioned from bounds at zIndex + 100', () => {
    const style = computeWindowStyle({
      window: makeWindow(),
      zIndex: 4,
      ...baseFlags,
    });
    expect(style).toEqual({
      top: 20,
      left: 10,
      width: 300,
      height: 200,
      zIndex: 104,
    });
  });
});
