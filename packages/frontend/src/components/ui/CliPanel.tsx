/**
 * CliPanel - Terminal-like panel showing raw AI output.
 */
import { useEffect, useRef } from 'react'
import { useDesktopStore } from '@/store'
import { useShallow } from 'zustand/react/shallow'
import styles from '@/styles/ui/CliPanel.module.css'

export function CliPanel() {
  const activeMonitorId = useDesktopStore(s => s.activeMonitorId)
  const history = useDesktopStore(useShallow(s => s.cliHistory[activeMonitorId] ?? []))
  const streaming = useDesktopStore(useShallow(s => s.cliStreaming))
  const clearCliHistory = useDesktopStore(s => s.clearCliHistory)

  const bodyRef = useRef<HTMLDivElement>(null)
  const shouldAutoScroll = useRef(true)

  // Track if user has scrolled up
  const handleScroll = () => {
    const el = bodyRef.current
    if (!el) return
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    shouldAutoScroll.current = isNearBottom
  }

  // Auto-scroll to bottom on new entries
  useEffect(() => {
    if (shouldAutoScroll.current && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight
    }
  }, [history.length, streaming])

  // Filter streaming entries by monitor
  const streamingEntries = Object.values(streaming).filter(
    e => (e.monitorId || 'monitor-0') === activeMonitorId
  )

  const entryClass = (type: string) => {
    switch (type) {
      case 'user': return styles.user
      case 'thinking': return styles.thinking
      case 'response': return styles.response
      case 'tool': return styles.tool
      case 'error': return styles.error
      case 'action-summary': return styles.actionSummary
      default: return styles.response
    }
  }

  return (
    <div className={styles.cliPanel}>
      <div className={styles.cliHeader}>
        <span className={styles.cliTitle}>Terminal</span>
        <button
          className={styles.cliClearButton}
          onClick={() => clearCliHistory(activeMonitorId)}
        >
          Clear
        </button>
      </div>
      <div className={styles.cliBody} ref={bodyRef} onScroll={handleScroll}>
        {history.map(entry => (
          <div key={entry.id} className={`${styles.entry} ${entryClass(entry.type)}`}>
            {entry.type === 'user' && <span className={styles.userPrompt}>&gt; </span>}
            {entry.content}
          </div>
        ))}
        {streamingEntries.map(entry => (
          <div key={entry.id} className={`${styles.entry} ${entryClass(entry.type)}`}>
            {entry.type === 'thinking' && <span className={styles.streamingLabel}>[thinking]</span>}
            {entry.content}
            <span className={styles.cursor} />
          </div>
        ))}
      </div>
    </div>
  )
}
