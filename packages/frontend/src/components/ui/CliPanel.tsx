/**
 * CliPanel - Tmux-style multi-monitor terminal view.
 * Shows all monitors simultaneously in a split-pane grid layout.
 */
import { useDesktopStore } from '@/store'
import { useShallow } from 'zustand/react/shallow'
import { TerminalPane } from './TerminalPane'
import styles from '@/styles/ui/CliPanel.module.css'

export function CliPanel() {
  const monitors = useDesktopStore(useShallow(s => s.monitors))
  const activeMonitorId = useDesktopStore(s => s.activeMonitorId)
  const switchMonitor = useDesktopStore(s => s.switchMonitor)

  const gridClass =
    monitors.length === 1 ? styles.grid1
    : monitors.length === 2 ? styles.grid2
    : styles.grid4

  return (
    <div className={`${styles.cliPanel} ${gridClass}`}>
      {monitors.map((monitor, i) => (
        <TerminalPane
          key={monitor.id}
          monitorId={monitor.id}
          index={i + 1}
          isFocused={monitor.id === activeMonitorId}
          onClick={() => switchMonitor(monitor.id)}
        />
      ))}
    </div>
  )
}
