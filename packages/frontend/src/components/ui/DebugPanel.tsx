/**
 * DebugPanel - Shows raw WebSocket interaction with the AI.
 */
import { useState, useRef, useCallback } from 'react'
import { useDesktopStore } from '@/store'
import type { DebugEntry } from '@/types/state'
import styles from '@/styles/DebugPanel.module.css'

function getSummary(entry: DebugEntry): string {
  const data = entry.data as Record<string, unknown>

  switch (entry.type) {
    case 'USER_MESSAGE':
      return truncate(String(data.content || ''), 60)
    case 'AGENT_RESPONSE':
      return truncate(String(data.content || ''), 60)
    case 'AGENT_THINKING':
      return truncate(String(data.content || ''), 60)
    case 'CONNECTION_STATUS':
      return `${data.status}${data.provider ? ` (${data.provider})` : ''}`
    case 'ACTIONS': {
      const actions = data.actions as Array<{ type: string }> | undefined
      if (actions?.length) {
        return actions.map(a => a.type).join(', ')
      }
      return 'no actions'
    }
    case 'TOOL_PROGRESS':
      return `${data.toolName}: ${data.status}`
    case 'ERROR':
      return truncate(String(data.error || 'Unknown error'), 60)
    default:
      return ''
  }
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str
  return str.slice(0, max) + '...'
}

export function DebugPanel() {
  const debugLog = useDesktopStore((state) => state.debugLog)
  const clearDebugLog = useDesktopStore((state) => state.clearDebugLog)
  const toggleDebugPanel = useDesktopStore((state) => state.toggleDebugPanel)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [position, setPosition] = useState({ x: 100, y: 100 })
  const [isDragging, setIsDragging] = useState(false)
  const dragOffset = useRef({ x: 0, y: 0 })

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    setIsDragging(true)
    dragOffset.current = {
      x: e.clientX - position.x,
      y: e.clientY - position.y
    }

    const handleMouseMove = (e: MouseEvent) => {
      setPosition({
        x: e.clientX - dragOffset.current.x,
        y: e.clientY - dragOffset.current.y
      })
    }

    const handleMouseUp = () => {
      setIsDragging(false)
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [position])

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp)
    const time = date.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    const ms = String(date.getMilliseconds()).padStart(3, '0')
    return `${time}.${ms}`
  }

  const formatData = (data: unknown) => {
    try {
      return JSON.stringify(data, null, 2)
    } catch {
      return String(data)
    }
  }

  const toggleExpand = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  return (
    <div
      className={styles.window}
      style={{ left: position.x, top: position.y }}
      data-dragging={isDragging}
    >
      <div className={styles.titleBar} onMouseDown={handleMouseDown}>
        <span className={styles.title}>Debug Log</span>
        <div className={styles.controls}>
          <button className={styles.controlBtn} onClick={clearDebugLog} title="Clear log">
            Clear
          </button>
          <button
            className={styles.controlBtn}
            data-action="close"
            onClick={toggleDebugPanel}
            title="Close"
          >
            ×
          </button>
        </div>
      </div>
      <div className={styles.content}>
        {debugLog.length === 0 ? (
          <div className={styles.empty}>No events yet. Send a message to see raw interactions.</div>
        ) : (
          debugLog.map((entry) => {
            const isExpanded = expandedIds.has(entry.id)
            const summary = getSummary(entry)

            return (
              <div
                key={entry.id}
                className={styles.entry}
                data-direction={entry.direction}
                data-expanded={isExpanded}
                onClick={() => toggleExpand(entry.id)}
              >
                <div className={styles.entryHeader}>
                  <span className={styles.direction}>
                    {entry.direction === 'out' ? '→' : '←'}
                  </span>
                  <span className={styles.type}>{entry.type}</span>
                  {summary && <span className={styles.summary}>{summary}</span>}
                  <span className={styles.time}>{formatTime(entry.timestamp)}</span>
                </div>
                {isExpanded && (
                  <pre className={styles.data}>{formatData(entry.data)}</pre>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
