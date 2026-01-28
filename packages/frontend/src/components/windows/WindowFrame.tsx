/**
 * WindowFrame - Draggable, resizable window container.
 */
import { useCallback, useRef, useState } from 'react'
import { useDesktopStore } from '@/store'
import type { WindowModel } from '@/types/state'
import { ContentRenderer } from './ContentRenderer'
import styles from './WindowFrame.module.css'

interface WindowFrameProps {
  window: WindowModel
  zIndex: number
  isFocused: boolean
}

export function WindowFrame({ window, zIndex, isFocused }: WindowFrameProps) {
  const { userFocusWindow, userCloseWindow, userMoveWindow, userResizeWindow } =
    useDesktopStore()

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
      <div className={styles.titleBar} onMouseDown={handleDragStart}>
        <div className={styles.title}>{window.title}</div>
        <div className={styles.controls}>
          <button
            className={styles.controlBtn}
            data-action="minimize"
            onClick={() => useDesktopStore.getState().applyAction({
              type: 'window.minimize',
              windowId: window.id,
            })}
          >
            −
          </button>
          <button
            className={styles.controlBtn}
            data-action="maximize"
            onClick={() => useDesktopStore.getState().applyAction({
              type: window.maximized ? 'window.restore' : 'window.maximize',
              windowId: window.id,
            })}
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
      <div className={styles.content}>
        <ContentRenderer content={window.content} />
      </div>

      {/* Resize handle */}
      {!window.maximized && (
        <div className={styles.resizeHandle} onMouseDown={handleResizeStart} />
      )}
    </div>
  )
}
