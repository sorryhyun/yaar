/**
 * WindowFrame - Draggable, resizable window container.
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { useDesktopStore, selectQueuedActionsCount, selectWindowAgent } from '@/store'
import { tryIframeSelfCapture } from '@/store/desktop'
import { useComponentAction } from '@/contexts/ComponentActionContext'
import type { WindowModel } from '@/types/state'
import { MemoizedContentRenderer } from './ContentRenderer'
import { LockOverlay } from './LockOverlay'
import styles from '@/styles/windows/WindowFrame.module.css'

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename.replace(/[/\\?%*:|"<>]/g, '-')
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

async function exportContent(content: WindowModel['content'], title: string, windowId?: string) {
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
          tableData.headers.map(h => `"${String(h).replace(/"/g, '""')}"`).join(','),
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
      // Three-tier iframe export: same-origin HTML → screenshot → URL fallback
      if (windowId) {
        const el = document.querySelector(`[data-window-id="${windowId}"] iframe`) as HTMLIFrameElement | null
        if (el) {
          // Tier 1: Same-origin HTML export
          try {
            const doc = el.contentDocument
            if (doc) {
              const html = doc.documentElement.outerHTML
              triggerDownload(new Blob([html], { type: 'text/html' }), `${title}.html`)
              return
            }
          } catch { /* cross-origin — fall through */ }

          // Tier 2: Screenshot via self-capture protocol
          if (el.contentWindow) {
            const imageData = await tryIframeSelfCapture(el)
            if (imageData) {
              const res = await fetch(imageData)
              const pngBlob = await res.blob()
              triggerDownload(pngBlob, `${title}.png`)
              return
            }
          }
        }
      }

      // Tier 3: URL fallback
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

  triggerDownload(blob, filename)
}

interface WindowFrameProps {
  window: WindowModel
  zIndex: number
  isFocused: boolean
}

function WindowFrameInner({ window, zIndex, isFocused }: WindowFrameProps) {
  // Subscribe to individual stable action refs — never triggers re-renders
  const userFocusWindow = useDesktopStore(s => s.userFocusWindow)
  const userCloseWindow = useDesktopStore(s => s.userCloseWindow)
  const userMoveWindow = useDesktopStore(s => s.userMoveWindow)
  const userResizeWindow = useDesktopStore(s => s.userResizeWindow)
  const queueBoundsUpdate = useDesktopStore(s => s.queueBoundsUpdate)
  const showContextMenu = useDesktopStore(s => s.showContextMenu)
  const queuedCount = useDesktopStore(selectQueuedActionsCount(window.id))
  const windowAgent = useDesktopStore(selectWindowAgent(window.id))
  const isSelected = useDesktopStore(s => s.selectedWindowIds.includes(window.id))
  const sendComponentAction = useComponentAction()

  const handleComponentAction = useCallback((
    action: string,
    parallel?: boolean,
    formData?: Record<string, string | number | boolean>,
    formId?: string,
    componentPath?: string[]
  ) => {
    sendComponentAction?.(window.id, window.title, action, parallel, formData, formId, componentPath)
  }, [sendComponentAction, window.id, window.title])

  // Stabilize render callbacks — use getState() inside to avoid addRenderingFeedback dep
  const windowId = window.id
  const onRenderSuccess = useCallback((requestId: string, winId: string, renderer: string) => {
    useDesktopStore.getState().addRenderingFeedback({ requestId, windowId: winId, renderer, success: true })
  }, [])
  const onRenderError = useCallback((requestId: string, winId: string, renderer: string, error: string, url?: string) => {
    useDesktopStore.getState().addRenderingFeedback({ requestId, windowId: winId, renderer, success: false, error, url })
  }, [])

  const frameRef = useRef<HTMLDivElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [isResizing, setIsResizing] = useState(false)
  const dragOffset = useRef({ x: 0, y: 0 })
  const listenersRef = useRef<Array<{ move: (e: MouseEvent) => void; up: (e: MouseEvent) => void }>>([])

  // Cleanup document listeners on unmount to prevent leaks
  useEffect(() => {
    return () => {
      for (const { move, up } of listenersRef.current) {
        document.removeEventListener('mousemove', move)
        document.removeEventListener('mouseup', up)
      }
      listenersRef.current = []
    }
  }, [])

  // Handle window focus
  const handleMouseDown = useCallback(() => {
    userFocusWindow(window.id)
  }, [userFocusWindow, window.id])

  // Handle title bar drag
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest(`.${styles.controls}`)) return

    e.preventDefault()
    setIsDragging(true)
    document.documentElement.classList.add('yaar-dragging')
    dragOffset.current = {
      x: e.clientX - window.bounds.x,
      y: e.clientY - window.bounds.y,
    }

    const TITLEBAR_H = 36
    const TASKBAR_H = 36

    const handleMouseMove = (e: MouseEvent) => {
      const vw = globalThis.innerWidth
      const vh = globalThis.innerHeight

      let newX = e.clientX - dragOffset.current.x
      let newY = e.clientY - dragOffset.current.y

      // Keep title bar reachable: at least 100px of width visible horizontally
      newX = Math.max(-(window.bounds.w - 100), Math.min(newX, vw - 100))
      // Top: can't go above viewport; Bottom: title bar must stay above taskbar
      newY = Math.max(0, Math.min(newY, vh - TASKBAR_H - TITLEBAR_H))

      userMoveWindow(window.id, newX, newY)
    }

    const entry = { move: handleMouseMove, up: handleMouseUp }
    function handleMouseUp() {
      setIsDragging(false)
      document.documentElement.classList.remove('yaar-dragging')
      queueBoundsUpdate(window.id)
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      listenersRef.current = listenersRef.current.filter(e => e !== entry)
    }

    listenersRef.current.push(entry)
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [window.id, window.bounds.x, window.bounds.y, userMoveWindow, queueBoundsUpdate])

  // Handle resize from any edge/corner
  const handleResizeStart = useCallback((direction: string, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsResizing(true)
    document.documentElement.classList.add('yaar-dragging')

    const startBounds = { ...window.bounds }
    const startMouseX = e.clientX
    const startMouseY = e.clientY

    const resizeTop = direction.includes('n')
    const resizeBottom = direction.includes('s')
    const resizeLeft = direction.includes('w')
    const resizeRight = direction.includes('e')

    const TASKBAR_H = 36

    const handleMouseMove = (e: MouseEvent) => {
      const dx = e.clientX - startMouseX
      const dy = e.clientY - startMouseY
      const vh = globalThis.innerHeight
      const vw = globalThis.innerWidth

      let newX = startBounds.x
      let newY = startBounds.y
      let newW = startBounds.w
      let newH = startBounds.h

      if (resizeRight) newW = startBounds.w + dx
      if (resizeLeft) { newW = startBounds.w - dx; newX = startBounds.x + dx }
      if (resizeBottom) newH = startBounds.h + dy
      if (resizeTop) { newH = startBounds.h - dy; newY = startBounds.y + dy }

      // Enforce minimums
      if (newW < 200) { if (resizeLeft) newX = startBounds.x + startBounds.w - 200; newW = 200 }
      if (newH < 150) { if (resizeTop) newY = startBounds.y + startBounds.h - 150; newH = 150 }

      // Clamp: top edge can't go above viewport
      if (newY < 0) { newH += newY; newY = 0 }
      // Clamp: bottom edge can't go below viewport minus taskbar
      const maxH = vh - TASKBAR_H - newY
      if (newH > maxH) newH = maxH
      // Clamp: right edge within viewport
      if (newX + newW > vw) newW = vw - newX
      // Clamp: left edge within viewport
      if (newX < 0) { newW += newX; newX = 0 }

      // Re-enforce minimums after clamping
      if (newW < 200) newW = 200
      if (newH < 150) newH = 150

      const posChanged = resizeLeft || resizeTop
      userResizeWindow(window.id, newW, newH, posChanged ? newX : undefined, posChanged ? newY : undefined)
    }

    const entry = { move: handleMouseMove, up: handleMouseUp }
    function handleMouseUp() {
      setIsResizing(false)
      document.documentElement.classList.remove('yaar-dragging')
      queueBoundsUpdate(window.id)
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      listenersRef.current = listenersRef.current.filter(e => e !== entry)
    }

    listenersRef.current.push(entry)
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [window.id, window.bounds, userResizeWindow, queueBoundsUpdate])

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
      data-window-id={window.id}
      data-focused={isFocused}
      data-selected={isSelected}
      data-dragging={isDragging}
      data-resizing={isResizing}
      data-agent-active={windowAgent?.status === 'active'}
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
          {windowAgent && (
            <div
              className={styles.agentBadge}
              data-status={windowAgent.status}
              title={`Pool agent: ${windowAgent.agentId} (${windowAgent.status})`}
            >
              <span className={styles.agentIcon}>
                {windowAgent.status === 'active' ? '⚡' : '💤'}
              </span>
            </div>
          )}
        </div>
        <div className={styles.controls}>
          <button
            className={styles.controlBtn}
            data-action="export"
            title="Export content"
            onClick={() => exportContent(window.content, window.title, window.id)}
          >
            ↑
          </button>
          <button
            className={styles.controlBtn}
            data-action="minimize"
            onClick={() => {
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
        <MemoizedContentRenderer
          content={window.content}
          windowId={windowId}
          requestId={window.requestId}
          onRenderSuccess={onRenderSuccess}
          onRenderError={onRenderError}
          onComponentAction={handleComponentAction}
        />
        {window.locked && <LockOverlay queuedCount={queuedCount} />}
      </div>

      {/* Resize edges and corners */}
      {!window.maximized && <>
        <div className={styles.resizeN} onMouseDown={(e) => handleResizeStart('n', e)} />
        <div className={styles.resizeS} onMouseDown={(e) => handleResizeStart('s', e)} />
        <div className={styles.resizeW} onMouseDown={(e) => handleResizeStart('w', e)} />
        <div className={styles.resizeE} onMouseDown={(e) => handleResizeStart('e', e)} />
        <div className={styles.resizeNW} onMouseDown={(e) => handleResizeStart('nw', e)} />
        <div className={styles.resizeNE} onMouseDown={(e) => handleResizeStart('ne', e)} />
        <div className={styles.resizeSW} onMouseDown={(e) => handleResizeStart('sw', e)} />
        <div className={styles.resizeSE} onMouseDown={(e) => handleResizeStart('se', e)} />
      </>}
    </div>
  )
}

export const WindowFrame = memo(WindowFrameInner)
