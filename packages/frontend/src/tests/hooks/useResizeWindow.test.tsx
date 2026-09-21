/**
 * The resize sibling of `useDragWindow.test.tsx`. What it pins is the clamping order —
 * minimums, then the viewport, then minimums again — because every one of those steps
 * has to leave the edge the user is *not* dragging exactly where it was.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { useResizeWindow } from '@/hooks/useResizeWindow';
import { useDesktopStore } from '@/store';
import type { WindowModel } from '@/types/state';

const windowId = '0/test';
const originalBounds = { x: 100, y: 100, w: 500, h: 300 };

function model(): WindowModel {
  return {
    id: windowId,
    title: 'Test',
    bounds: { ...originalBounds },
    content: { renderer: 'text', data: '' },
    minimized: false,
    maximized: false,
    monitorId: '0',
  };
}

function startEvent(x: number, y: number): React.MouseEvent {
  return {
    button: 0,
    clientX: x,
    clientY: y,
    preventDefault() {},
    stopPropagation() {},
  } as React.MouseEvent;
}

/** Start a resize from `direction` at (x, y), move to (tx, ty) unless null, and release. */
function resize(direction: string, [x, y]: [number, number], to: [number, number] | null) {
  const [tx, ty] = to ?? [x, y];
  const hook = renderHook(() => useResizeWindow({ windowId, bounds: originalBounds }));
  act(() => {
    hook.result.current.handleResizeStart(direction, startEvent(x, y));
    if (to) document.dispatchEvent(new MouseEvent('mousemove', { clientX: tx, clientY: ty }));
    document.dispatchEvent(new MouseEvent('mouseup', { clientX: tx, clientY: ty }));
  });
  hook.unmount();
  return useDesktopStore.getState().windows[windowId].bounds;
}

describe('useResizeWindow', () => {
  beforeEach(() => {
    useDesktopStore.setState({
      windows: { [windowId]: model() },
      zOrder: [windowId],
      focusedWindowId: windowId,
      activeMonitorId: '0',
      pendingInteractions: [],
    });
  });

  afterEach(() => {
    document.documentElement.classList.remove('yaar-dragging');
  });

  it('grows from the right edge without moving the window', () => {
    expect(resize('e', [600, 200], [650, 200])).toEqual({ x: 100, y: 100, w: 550, h: 300 });
  });

  it('pins the right edge when the left edge is dragged past the minimum width', () => {
    // 500 wide, dragged 400px inward from the left: 100 < 200, so it stops at 200 and the
    // right edge (600) stays where it was.
    expect(resize('w', [100, 200], [500, 200])).toEqual({ x: 400, y: 100, w: 200, h: 300 });
  });

  it('pins the bottom edge when the top edge is dragged past the minimum height', () => {
    expect(resize('n', [300, 100], [300, 350])).toEqual({ x: 100, y: 250, w: 500, h: 150 });
  });

  it('stops the top edge at the top of the viewport', () => {
    const b = resize('n', [300, 100], [300, -50]);
    expect(b.y).toBe(0);
    // Bottom edge unmoved: 100 + 300.
    expect(b.h).toBe(400);
  });

  it('queues exactly one resize for the server, and none for a click on the handle', () => {
    resize('se', [600, 400], null);
    expect(useDesktopStore.getState().pendingInteractions).toHaveLength(0);

    resize('se', [600, 400], [640, 420]);
    const pending = useDesktopStore.getState().pendingInteractions;
    expect(pending).toHaveLength(1);
    expect(pending[0].type).toBe('window.resize');
  });

  it('releases the dragging class when the window is destroyed mid-resize', () => {
    const hook = renderHook(() => useResizeWindow({ windowId, bounds: originalBounds }));
    act(() => {
      hook.result.current.handleResizeStart('se', startEvent(600, 400));
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 640, clientY: 420 }));
    });
    expect(document.documentElement.classList.contains('yaar-dragging')).toBe(true);
    expect(hook.result.current.isResizing).toBe(true);

    act(() => hook.unmount());
    expect(document.documentElement.classList.contains('yaar-dragging')).toBe(false);
  });

  it('ignores anything but the primary button', () => {
    const hook = renderHook(() => useResizeWindow({ windowId, bounds: originalBounds }));
    act(() => {
      hook.result.current.handleResizeStart('se', { ...startEvent(600, 400), button: 2 });
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 700, clientY: 500 }));
    });
    expect(hook.result.current.isResizing).toBe(false);
    expect(useDesktopStore.getState().windows[windowId].bounds).toEqual(originalBounds);
    hook.unmount();
  });
});
