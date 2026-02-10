/**
 * WindowManager - Renders all windows in z-order.
 */
import { useMemo } from 'react'
import { useDesktopStore, selectVisibleWindows } from '@/store'
import { useShallow } from 'zustand/react/shallow'
import { WindowFrame } from '../windows/WindowFrame'

export function WindowManager() {
  const windows = useDesktopStore(useShallow(selectVisibleWindows))
  const zOrder = useDesktopStore(s => s.zOrder)
  const focusedWindowId = useDesktopStore(s => s.focusedWindowId)

  // Pre-compute z-index map: O(n) instead of O(n^2) from indexOf per window
  const zIndexMap = useMemo(() => {
    const map = new Map<string, number>()
    zOrder.forEach((id, i) => map.set(id, i))
    return map
  }, [zOrder])

  return (
    <>
      {windows.map((window) => (
        <WindowFrame
          key={window.id}
          window={window}
          zIndex={zIndexMap.get(window.id) ?? 0}
          isFocused={window.id === focusedWindowId}
        />
      ))}
    </>
  )
}
