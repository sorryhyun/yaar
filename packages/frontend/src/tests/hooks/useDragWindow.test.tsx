import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'bun:test';
import { useDragWindow } from '@/hooks/useDragWindow';
import { useDesktopStore } from '@/store';
import type { WindowModel } from '@/types/state';

const windowId = '0/test';
const originalBounds = { x: 100, y: 100, w: 500, h: 300 };

function model(overrides: Partial<WindowModel> = {}): WindowModel {
  return {
    id: windowId,
    title: 'Test',
    bounds: { ...originalBounds },
    content: { renderer: 'text', data: '' },
    minimized: false,
    maximized: false,
    monitorId: '0',
    ...overrides,
  };
}

function startEvent(x: number, y: number): React.MouseEvent {
  return {
    button: 0,
    clientX: x,
    clientY: y,
    preventDefault() {},
  } as React.MouseEvent;
}

describe('useDragWindow', () => {
  beforeEach(() => {
    useDesktopStore.setState({
      windows: { [windowId]: model() },
      zOrder: [windowId],
      focusedWindowId: windowId,
      activeMonitorId: '0',
      pendingInteractions: [],
    });
  });

  it('collapses a stray selection on drag start', () => {
    const host = document.createElement('p');
    host.textContent = 'window body text';
    document.body.append(host);
    const range = document.createRange();
    range.selectNodeContents(host);
    const selection = globalThis.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const hook = renderHook(() => useDragWindow({ windowId, bounds: originalBounds }));

    act(() => {
      hook.result.current.handleDragStart(startEvent(200, 110));
      document.dispatchEvent(new MouseEvent('mouseup', { clientX: 200, clientY: 110 }));
    });

    // preventDefault on mousedown suppresses the browser's own collapse, so the
    // titlebar would otherwise leave the selection stuck with nothing to clear it.
    expect(selection?.rangeCount).toBe(0);
    host.remove();
    hook.unmount();
  });

  it('uses true maximize when a window is dragged to the top edge', () => {
    const hook = renderHook(() => useDragWindow({ windowId, bounds: originalBounds }));

    act(() => {
      hook.result.current.handleDragStart(startEvent(200, 110));
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 240, clientY: 4 }));
      document.dispatchEvent(new MouseEvent('mouseup', { clientX: 240, clientY: 4 }));
    });

    const window = useDesktopStore.getState().windows[windowId];
    expect(window.maximized).toBe(true);
    expect(window.previousBounds).toEqual(originalBounds);
    hook.unmount();
  });

  it('does not restore a maximized window until the pointer moves', () => {
    useDesktopStore.setState({
      windows: {
        [windowId]: model({
          maximized: true,
          previousBounds: { ...originalBounds },
        }),
      },
    });
    const hook = renderHook(() => useDragWindow({ windowId, bounds: originalBounds }));

    act(() => {
      hook.result.current.handleDragStart(startEvent(300, 18));
      document.dispatchEvent(new MouseEvent('mouseup', { clientX: 300, clientY: 18 }));
    });

    expect(useDesktopStore.getState().windows[windowId].maximized).toBe(true);
    hook.unmount();
  });

  it('releases the dragging class when the window is destroyed mid-drag', () => {
    const hook = renderHook(() => useDragWindow({ windowId, bounds: originalBounds }));

    act(() => {
      hook.result.current.handleDragStart(startEvent(200, 110));
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 240, clientY: 160 }));
    });
    expect(document.documentElement.classList.contains('yaar-dragging')).toBe(true);

    // No mouseup: this is the window closing under the drag — an agent's `window.close`,
    // Ctrl+W, a monitor switch, a RESYNC snapshot. The class is what makes every app
    // iframe `pointer-events: none`, so leaving it on bricks every app until reload.
    act(() => hook.unmount());
    expect(document.documentElement.classList.contains('yaar-dragging')).toBe(false);
  });

  it('leaves the dragging class alone when an idle window unmounts', () => {
    const hook = renderHook(() => useDragWindow({ windowId, bounds: originalBounds }));
    document.documentElement.classList.add('yaar-dragging');

    // Another window is mid-drag; this one never started a gesture and must not
    // pull the class out from under it.
    act(() => hook.unmount());
    expect(document.documentElement.classList.contains('yaar-dragging')).toBe(true);
    document.documentElement.classList.remove('yaar-dragging');
  });
});
