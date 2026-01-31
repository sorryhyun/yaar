/**
 * WindowFrame - Draggable, resizable window container.
 */
import { useCallback, useRef, useState } from 'react'
import { useDesktopStore, selectQueuedActionsCount } from '@/store'
import { useComponentAction } from '@/contexts/ComponentActionContext'
import type { WindowModel } from '@/types/state'
import { ContentRenderer } from './ContentRenderer'
import { LockOverlay } from './LockOverlay'
import styles from '@/styles/WindowFrame.module.css'

function exportContent(content: WindowModel['content'], title: string) {
  const { renderer, data } = content
  let blob: Blob
  let filename: string

  switch (renderer) {
    case 'markdown':
    case 'text':
      blob = new Blob([String(data)], { type: 'text/plain' })
      filename = `${title}.${renderer === 'markdown' ? 'md' : 'txt'}`
      break
    case 'html':
      blob = new Blob([String(data)], { type: 'text/html' })
      filename = `${title}.html`
      break
    case 'table': {
      const tableData = data as { headers?: string[]; rows?: unknown[][] }
      if (tableData.headers && tableData.rows) {
        const csv = [
          tableData.headers.join(','),
          ...tableData.rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
        ].join('\n')
        blob = new Blob([csv], { type: 'text/csv' })
        filename = `${title}.csv`
      } else {
        blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
        filename = `${title}.json`
      }
      break
    }
    case 'iframe': {
      const iframeData = data as { url?: string } | string
      const url = typeof iframeData === 'string' ? iframeData : iframeData?.url
      blob = new Blob([url || ''], { type: 'text/plain' })
      filename = `${title}-url.txt`
      break
    }
    default:
      blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      filename = `${title}.json`
  }

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename.replace(/[/\\?%*:|"<>]/g, '-')
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

interface WindowFrameProps {
  window: WindowModel
  zIndex: number
  isFocused: boolean
}

export function WindowFrame({ window, zIndex, isFocused }: WindowFrameProps) {
  const { userFocusWindow, userCloseWindow, userMoveWindow, userResizeWindow, showContextMenu, addRenderingFeedback, logInteraction } =
    useDesktopStore()
  const queuedCount = useDesktopStore(selectQueuedActionsCount(window.id))
  const sendComponentAction = useComponentAction()

  const frameRef = useRef<HTMLDivElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [isResizing, setIsResizing] = useState(false)
  const dragOffset = useRef({ x: 0, y: 0 })

  // Handle window focus
  const handleMouseDown = useCallback(() => {
    userFocusWindow(window.id)
  }, [userFocusWindow, window.id])

  // Handle title bar drag
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest(`.${styles.controls}`)) return

    e.preventDefault()
    setIsDragging(true)
    dragOffset.current = {
      x: e.clientX - window.bounds.x,
      y: e.clientY - window.bounds.y,
    }

    const handleMouseMove = (e: MouseEvent) => {
      userMoveWindow(
        window.id,
        e.clientX - dragOffset.current.x,
        e.clientY - dragOffset.current.y
      )
    }

    const handleMouseUp = () => {
      setIsDragging(false)
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [window.id, window.bounds.x, window.bounds.y, userMoveWindow])

  // Handle resize
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsResizing(true)

    const startW = window.bounds.w
    const startH = window.bounds.h
    const startX = e.clientX
    const startY = e.clientY

    const handleMouseMove = (e: MouseEvent) => {
      const newW = Math.max(200, startW + (e.clientX - startX))
      const newH = Math.max(150, startH + (e.clientY - startY))
      userResizeWindow(window.id, newW, newH)
    }

    const handleMouseUp = () => {
      setIsResizing(false)
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [window.id, window.bounds.w, window.bounds.h, userResizeWindow])

  // Determine position/size (handle maximized state)
  const style: React.CSSProperties = window.maximized
    ? {
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        zIndex: zIndex + 100,
      }
    : {
        top: window.bounds.y,
        left: window.bounds.x,
        width: window.bounds.w,
        height: window.bounds.h,
        zIndex: zIndex + 100,
      }

  return (
    <div
      ref={frameRef}
      className={styles.frame}
      style={style}
      data-focused={isFocused}
      data-dragging={isDragging}
      data-resizing={isResizing}
      onMouseDown={handleMouseDown}
    >
      {/* Title bar */}
      <div
        className={styles.titleBar}
        onMouseDown={handleDragStart}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          showContextMenu(e.clientX, e.clientY, window.id)
        }}
      >
        <div className={styles.titleSection}>
          <div className={styles.title}>{window.title}</div>
          {window.locked && (
            <div
              className={styles.lockBadge}
              title={`Locked by: ${window.lockedBy || 'unknown'}`}
            >
              <span className={styles.lockIcon}>🔒</span>
            </div>
          )}
        </div>
        <div className={styles.controls}>
          <button
            className={styles.controlBtn}
            data-action="export"
            title="Export content"
            onClick={() => exportContent(window.content, window.title)}
          >
            ↓
          </button>
          <button
            className={styles.controlBtn}
            data-action="minimize"
            onClick={() => {
              logInteraction({ type: 'window.minimize', windowId: window.id, windowTitle: window.title })
              useDesktopStore.getState().applyAction({
                type: 'window.minimize',
                windowId: window.id,
              })
            }}
          >
            −
          </button>
          <button
            className={styles.controlBtn}
            data-action="maximize"
            onClick={() => {
              logInteraction({ type: 'window.maximize', windowId: window.id, windowTitle: window.title })
              useDesktopStore.getState().applyAction({
                type: window.maximized ? 'window.restore' : 'window.maximize',
                windowId: window.id,
              })
            }}
          >
            □
          </button>
          <button
            className={styles.controlBtn}
            data-action="close"
            onClick={() => userCloseWindow(window.id)}
          >
            ×
          </button>
        </div>
      </div>

      {/* Content area */}
      <div
        className={styles.content}
        onContextMenu={(e) => {
          e.preventDefault()
          showContextMenu(e.clientX, e.clientY, window.id)
        }}
      >
        <ContentRenderer
          content={window.content}
          windowId={window.id}
          requestId={window.requestId}
          onRenderSuccess={(requestId, windowId, renderer) => {
            addRenderingFeedback({ requestId, windowId, renderer, success: true })
          }}
          onRenderError={(requestId, windowId, renderer, error, url) => {
            addRenderingFeedback({ requestId, windowId, renderer, success: false, error, url })
          }}
          onComponentAction={(action, parallel, formData, formId, componentPath) => {
            sendComponentAction?.(window.id, window.title, action, parallel, formData, formId, componentPath)
          }}
        />
        {window.locked && <LockOverlay queuedCount={queuedCount} />}
      </div>

      {/* Resize handle */}
      {!window.maximized && (
        <div className={styles.resizeHandle} onMouseDown={handleResizeStart} />
      )}
    </div>
  )
}
