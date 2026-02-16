/**
 * WindowManager - Renders all windows in z-order.
 * Renders widget windows first (lower layer), then standard windows.
 */
import { useMemo } from 'react';
import { useDesktopStore, selectVisibleWindows, selectWidgetWindows } from '@/store';
import { useShallow } from 'zustand/react/shallow';
import { WindowFrame } from '../windows/WindowFrame';

export function WindowManager() {
  const widgets = useDesktopStore(useShallow(selectWidgetWindows));
  const windows = useDesktopStore(useShallow(selectVisibleWindows));
  const zOrder = useDesktopStore((s) => s.zOrder);
  const focusedWindowId = useDesktopStore((s) => s.focusedWindowId);

  // Pre-compute z-index map: O(n) instead of O(n^2) from indexOf per window
  const zIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    zOrder.forEach((id, i) => map.set(id, i));
    return map;
  }, [zOrder]);

  return (
    <>
      {widgets.map((window) => (
        <WindowFrame
          key={window.id}
          window={window}
          zIndex={zIndexMap.get(window.id) ?? 0}
          isFocused={window.id === focusedWindowId}
        />
      ))}
      {windows.map((window) => (
        <WindowFrame
          key={window.id}
          window={window}
          zIndex={zIndexMap.get(window.id) ?? 0}
          isFocused={window.id === focusedWindowId}
        />
      ))}
    </>
  );
}
