/**
 * WindowManager - Renders all windows in z-order.
 * Renders widget windows first (lower layer), then standard windows.
 */
import { useMemo } from 'react';
import {
  useDesktopStore,
  selectVisibleWindows,
  selectWidgetWindows,
  selectAllIframeWindows,
} from '@/store';
import { DEFAULT_MONITOR_ID } from '@yaar/shared';
import { useShallow } from 'zustand/react/shallow';
import { WindowFrame } from '../window/WindowFrame';

export function WindowManager() {
  const widgets = useDesktopStore(useShallow(selectWidgetWindows));
  const windows = useDesktopStore(useShallow(selectVisibleWindows));
  const allIframes = useDesktopStore(useShallow(selectAllIframeWindows));
  const zOrder = useDesktopStore((s) => s.zOrder);
  const activeMonitorId = useDesktopStore((s) => s.activeMonitorId);
  const focusedWindowId = useDesktopStore((s) => s.focusedWindowId);

  // Pre-compute z-index map: O(n) instead of O(n^2) from indexOf per window
  const zIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    zOrder.forEach((id, i) => map.set(id, i));
    return map;
  }, [zOrder]);

  return (
    <>
      {/* All iframe windows in a single list so monitor switches only toggle
          CSS visibility instead of unmounting/remounting (which destroys iframe state). */}
      {allIframes.map((window) => {
        const onActiveMonitor = (window.monitorId ?? DEFAULT_MONITOR_ID) === activeMonitorId;
        const hidden = !onActiveMonitor || window.minimized;
        return (
          <WindowFrame
            key={window.id}
            window={window}
            zIndex={hidden ? -1 : (zIndexMap.get(window.id) ?? 0)}
            isFocused={!hidden && window.id === focusedWindowId}
            hidden={hidden}
          />
        );
      })}
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
