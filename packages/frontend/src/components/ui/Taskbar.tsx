/**
 * Taskbar - Shows monitor tabs, minimized window tabs, and new monitor button.
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
  const monitors = useDesktopStore(s => s.monitors)
  const activeMonitorId = useDesktopStore(s => s.activeMonitorId)
  const switchMonitor = useDesktopStore(s => s.switchMonitor)
  const createMonitor = useDesktopStore(s => s.createMonitor)
  const removeMonitor = useDesktopStore(s => s.removeMonitor)

  const showMonitorTabs = monitors.length > 1

  return (
    <div className={styles.taskbar}>
      {/* Monitor tabs (left) */}
      {showMonitorTabs && (
        <div className={styles.monitorTabs}>
          {monitors.map(m => (
            <button
              key={m.id}
              className={`${styles.monitorTab} ${m.id === activeMonitorId ? styles.monitorTabActive : ''}`}
              onClick={() => switchMonitor(m.id)}
              title={m.label}
            >
              {m.label}
              <span
                className={styles.monitorClose}
                role="button"
                aria-label={`Close ${m.label}`}
                onClick={(e) => {
                  e.stopPropagation()
                  removeMonitor(m.id)
                }}
              >
                &#x2715;
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Minimized window tabs (center) */}
      {minimizedWindows.length > 0 && (
        <div className={styles.windowTabs}>
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
      )}

      {/* New monitor button (right, always visible) */}
      <button
        className={styles.newMonitorButton}
        onClick={() => createMonitor()}
        title="Create new monitor"
      >
        &gt;
      </button>
    </div>
  )
}
