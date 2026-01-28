/**
 * WindowManager - Renders all windows in z-order.
 */
import { useDesktopStore, selectVisibleWindows } from '@/store'
import { WindowFrame } from '../windows/WindowFrame'

export function WindowManager() {
  const windows = useDesktopStore(selectVisibleWindows)
  const zOrder = useDesktopStore(s => s.zOrder)
  const focusedWindowId = useDesktopStore(s => s.focusedWindowId)

  return (
    <>
      {windows.map((window) => (
        <WindowFrame
          key={window.id}
          window={window}
          zIndex={zOrder.indexOf(window.id)}
          isFocused={window.id === focusedWindowId}
        />
      ))}
    </>
  )
}
