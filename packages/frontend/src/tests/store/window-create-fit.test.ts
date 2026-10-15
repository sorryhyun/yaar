/**
 * A window the agent opens lands wholly on screen, moved before it is shrunk.
 *
 * The desktop used to narrow an oversized window in place: a 1400px window asked for at
 * x=306 on a 1600px desktop kept x=306, and its right edge — the window controls, the
 * app's Send button — sat past the viewport (GitHub issue #182). The server fits the
 * bounds to the viewport it last heard about; this is the desktop's own backstop.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { WindowBounds } from '@yaar/shared';
import { useDesktopStore } from '@/store/desktop';
import { TASKBAR_HEIGHT } from '@/constants/layout';

const VW = 1600;
const VH = 900;

let savedW: number;
let savedH: number;

function open(bounds: WindowBounds, extra: Record<string, unknown> = {}) {
  useDesktopStore.getState().applyAction({
    type: 'window.create',
    windowId: 'w1',
    title: 'Board',
    bounds,
    content: { renderer: 'markdown', data: '' },
    ...extra,
  } as Parameters<ReturnType<typeof useDesktopStore.getState>['applyAction']>[0]);
  return useDesktopStore.getState().windows['0/w1'];
}

describe('window.create fits the window to the viewport', () => {
  beforeEach(() => {
    savedW = globalThis.innerWidth;
    savedH = globalThis.innerHeight;
    globalThis.innerWidth = VW;
    globalThis.innerHeight = VH;
    useDesktopStore.setState({
      windows: {},
      zOrder: [],
      focusedWindowId: null,
      activeMonitorId: '0',
    });
  });

  afterEach(() => {
    globalThis.innerWidth = savedW;
    globalThis.innerHeight = savedH;
  });

  it('moves the reported window left rather than cutting off its right edge', () => {
    const win = open({ x: 306, y: 40, w: 1400, h: 600 });
    expect(win?.bounds).toEqual({ x: 200, y: 40, w: 1400, h: 600 });
    expect(win!.bounds.x + win!.bounds.w).toBeLessThanOrEqual(VW);
  });

  it('moves a window up rather than shortening it', () => {
    const win = open({ x: 100, y: 500, w: 800, h: 600 });
    expect(win?.bounds).toEqual({ x: 100, y: VH - TASKBAR_HEIGHT - 600, w: 800, h: 600 });
  });

  it('shrinks only a window larger than the viewport', () => {
    const win = open({ x: 50, y: 50, w: 2400, h: 2000 });
    expect(win?.bounds).toEqual({ x: 0, y: 0, w: VW, h: VH - TASKBAR_HEIGHT });
  });

  it('leaves a window that already fits exactly where it was asked to go', () => {
    const win = open({ x: 120, y: 80, w: 800, h: 500 });
    expect(win?.bounds).toEqual({ x: 120, y: 80, w: 800, h: 500 });
  });

  it('opens un-maximized; a later maximize still restores the fitted bounds', () => {
    const win = open({ x: 306, y: 40, w: 1400, h: 600 });
    expect(win?.maximized).toBe(false);
    const { applyAction } = useDesktopStore.getState();
    applyAction({ type: 'window.maximize', windowId: '0/w1' });
    applyAction({ type: 'window.restore', windowId: '0/w1' });
    expect(useDesktopStore.getState().windows['0/w1']?.bounds).toEqual({
      x: 200,
      y: 40,
      w: 1400,
      h: 600,
    });
  });
});
