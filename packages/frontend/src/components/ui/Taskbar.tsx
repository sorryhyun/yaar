/**
 * Taskbar - Shows tabs for minimized windows so users can restore them.
 */
import { useDesktopStore, selectMinimizedWindows } from '@/store'
import { useShallow } from 'zustand/react/shallow'
import styles from '@/styles/Taskbar.module.css'

export function Taskbar() {
  const minimizedWindows = useDesktopStore(useShallow(selectMinimizedWindows))
  const userFocusWindow = useDesktopStore(s => s.userFocusWindow)

  if (minimizedWindows.length === 0) return null

  return (
    <div className={styles.taskbar}>
      {minimizedWindows.map(win => (
        <button
          key={win.id}
          className={styles.tab}
          onClick={() => userFocusWindow(win.id)}
          title={win.title}
        >
          <span className={styles.tabTitle}>{win.title}</span>
        </button>
      ))}
    </div>
  )
}
