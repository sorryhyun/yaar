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

    const listenersRef = { current: [] };
    const hook = renderHook(() =>
      useDragWindow({ windowId, bounds: originalBounds, listenersRef }),
    );

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
    const listenersRef = { current: [] };
    const hook = renderHook(() =>
      useDragWindow({
        windowId,
        bounds: originalBounds,
        listenersRef,
      }),
    );

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
    const listenersRef = { current: [] };
    const hook = renderHook(() =>
      useDragWindow({
        windowId,
        bounds: originalBounds,
        listenersRef,
      }),
    );

    act(() => {
      hook.result.current.handleDragStart(startEvent(300, 18));
      document.dispatchEvent(new MouseEvent('mouseup', { clientX: 300, clientY: 18 }));
    });

    expect(useDesktopStore.getState().windows[windowId].maximized).toBe(true);
    hook.unmount();
  });
});
