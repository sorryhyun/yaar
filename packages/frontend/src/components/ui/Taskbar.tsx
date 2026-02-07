/**
 * Taskbar - Shows tabs for minimized windows so users can restore them.
 */
import { useDesktopStore, selectMinimizedWindows } from '@/store'
import { useShallow } from 'zustand/react/shallow'
import styles from '@/styles/Taskbar.module.css'

const rendererIcons: Record<string, string> = {
  markdown: '\u{1F4C4}',
  html: '\u{1F310}',
  iframe: '\u{1F310}',
  table: '\u{1F4CA}',
  text: '\u{1F4DD}',
  component: '\u{1F9E9}',
}

export function Taskbar() {
  const minimizedWindows = useDesktopStore(useShallow(selectMinimizedWindows))
  const userFocusWindow = useDesktopStore(s => s.userFocusWindow)
  const userCloseWindow = useDesktopStore(s => s.userCloseWindow)

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
          <span className={styles.tabIcon}>
            {rendererIcons[win.content.renderer] ?? '\u{1F4C4}'}
          </span>
          <span className={styles.tabTitle}>{win.title}</span>
          <span
            className={styles.tabClose}
            role="button"
            aria-label={`Close ${win.title}`}
            onClick={(e) => {
              e.stopPropagation()
              userCloseWindow(win.id)
            }}
          >
            &#x2715;
          </span>
        </button>
      ))}
    </div>
  )
}
