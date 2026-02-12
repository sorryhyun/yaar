/**
 * DrawingOverlay - Full-screen canvas for freehand drawing.
 *
 * Double-press Ctrl (or click the pencil button) to toggle pencil mode.
 * Then click+drag to draw. Double-press Ctrl again or Escape to exit and capture.
 * The saved image includes a screenshot of the current screen with annotations on top.
 */
import { useRef, useState, useEffect, useCallback } from 'react'
import html2canvas from 'html2canvas'
import { useDesktopStore } from '@/store'
import styles from '@/styles/ui/DrawingOverlay.module.css'

interface Point {
  x: number
  y: number
}

const DOUBLE_PRESS_MS = 350

export function DrawingOverlay() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [hasStrokes, setHasStrokes] = useState(false)
  const pencilMode = useDesktopStore(state => state.pencilMode)
  const setPencilMode = useDesktopStore(state => state.setPencilMode)
  const saveDrawing = useDesktopStore(state => state.saveDrawing)
  const hasDrawing = useDesktopStore(state => state.hasDrawing)

  const isDrawingRef = useRef(false)
  const lastPointRef = useRef<Point | null>(null)
  const lastCtrlUpRef = useRef(0)
  const hasStrokesRef = useRef(false)

  hasStrokesRef.current = hasStrokes

  // Clear canvas when drawing is consumed (hasDrawing: true → false)
  const prevHasDrawingRef = useRef(false)
  useEffect(() => {
    if (prevHasDrawingRef.current && !hasDrawing) {
      const canvas = canvasRef.current
      if (canvas) {
        const ctx = canvas.getContext('2d')
        if (ctx) {
          ctx.clearRect(0, 0, canvas.width, canvas.height)
          setHasStrokes(false)
        }
      }
    }
    prevHasDrawingRef.current = hasDrawing
  }, [hasDrawing])

  // Resize canvas to match window size
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const resize = () => {
      const tempCanvas = document.createElement('canvas')
      tempCanvas.width = canvas.width
      tempCanvas.height = canvas.height
      const tempCtx = tempCanvas.getContext('2d')
      if (tempCtx) {
        tempCtx.drawImage(canvas, 0, 0)
      }

      canvas.width = window.innerWidth
      canvas.height = window.innerHeight

      const ctx = canvas.getContext('2d')
      if (ctx && tempCtx) {
        ctx.drawImage(tempCanvas, 0, 0)
      }
    }

    resize()
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])

  const drawLine = useCallback((from: Point, to: Point) => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.lineTo(to.x, to.y)
    ctx.strokeStyle = 'rgba(255, 50, 30, 0.9)'
    ctx.lineWidth = 4
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.stroke()
  }, [])

  // Capture screen with drawing overlay
  const captureScreenWithDrawing = useCallback(async () => {
    console.log('[Drawing] captureScreenWithDrawing called')
    const drawingCanvas = canvasRef.current
    if (!drawingCanvas) {
      console.log('[Drawing] captureScreenWithDrawing — no canvas ref!')
      return
    }

    try {
      const dpr = window.devicePixelRatio || 1
      console.log('[Drawing] calling html2canvas...', { dpr, bodySize: `${document.body.clientWidth}x${document.body.clientHeight}` })
      const screenshot = await html2canvas(document.body, {
        ignoreElements: (element) => element === drawingCanvas,
        useCORS: true,
        logging: false,
        scale: dpr,
      })
      console.log('[Drawing] html2canvas done', { width: screenshot.width, height: screenshot.height })

      const compositeCanvas = document.createElement('canvas')
      compositeCanvas.width = screenshot.width
      compositeCanvas.height = screenshot.height
      const ctx = compositeCanvas.getContext('2d')

      if (ctx) {
        ctx.drawImage(screenshot, 0, 0)
        ctx.drawImage(drawingCanvas, 0, 0, drawingCanvas.width, drawingCanvas.height,
          0, 0, screenshot.width, screenshot.height)
        const dataUrl = compositeCanvas.toDataURL('image/webp', 0.95)
        console.log('[Drawing] saveDrawing called, dataUrl length:', dataUrl.length)
        saveDrawing(dataUrl)
        console.log('[Drawing] store state after save:', {
          hasDrawing: useDesktopStore.getState().hasDrawing,
          canvasDataUrl: useDesktopStore.getState().canvasDataUrl?.length,
        })
      } else {
        console.log('[Drawing] failed to get composite canvas context')
      }
    } catch (error) {
      console.error('[Drawing] html2canvas FAILED:', error)
      const dataUrl = drawingCanvas.toDataURL('image/webp', 0.95)
      console.log('[Drawing] fallback saveDrawing, dataUrl length:', dataUrl.length)
      saveDrawing(dataUrl)
    }
  }, [saveDrawing])

  // Exit pencil mode — capture is handled by the lifecycle effect below
  const exitPencilMode = useCallback(() => {
    setPencilMode(false)
  }, [setPencilMode])

  // Double-press Ctrl to toggle pencil mode, Escape to exit
  useEffect(() => {
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Control') {
        const now = Date.now()
        if (now - lastCtrlUpRef.current < DOUBLE_PRESS_MS) {
          const current = useDesktopStore.getState().pencilMode
          if (current) {
            exitPencilMode()
          } else {
            setPencilMode(true)
          }
          lastCtrlUpRef.current = 0
        } else {
          lastCtrlUpRef.current = now
        }
      }
      if (e.key === 'Escape' && useDesktopStore.getState().pencilMode) {
        exitPencilMode()
      }
    }
    window.addEventListener('keyup', handleKeyUp)
    return () => window.removeEventListener('keyup', handleKeyUp)
  }, [exitPencilMode, setPencilMode])

  // Pencil mode lifecycle: blur on enter, capture on exit
  const prevPencilMode = useRef(false)
  useEffect(() => {
    console.log('[Drawing] lifecycle effect', { pencilMode, prev: prevPencilMode.current, hasStrokes: hasStrokesRef.current })
    if (pencilMode && !prevPencilMode.current) {
      // Entering pencil mode — blur active element so canvas receives events
      console.log('[Drawing] ENTERING pencil mode, activeElement:', document.activeElement?.tagName, document.activeElement?.className)
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur()
      }
    }
    if (!pencilMode && prevPencilMode.current) {
      isDrawingRef.current = false
      lastPointRef.current = null
      if (hasStrokesRef.current && useDesktopStore.getState().hasDrawing) {
        // Upgrade with screenshot composite (only if drawing wasn't already consumed)
        console.log('[Drawing] EXITING pencil mode — upgrading with composite capture')
        captureScreenWithDrawing()
      } else {
        console.log('[Drawing] EXITING pencil mode — no upgrade needed')
      }
    }
    prevPencilMode.current = pencilMode
  }, [pencilMode, captureScreenWithDrawing])

  // Native event listeners for drawing.
  useEffect(() => {
    if (!pencilMode) return

    const canvas = canvasRef.current
    if (!canvas) return

    console.log('[Drawing] pencilMode ON — attaching listeners', {
      canvasSize: `${canvas.width}x${canvas.height}`,
      pointerEvents: getComputedStyle(canvas).pointerEvents,
      zIndex: getComputedStyle(canvas).zIndex,
      clipPath: getComputedStyle(canvas).clipPath,
      dataActive: canvas.getAttribute('data-active'),
    })

    // Debug: log what element is actually at click point
    const debugClick = (e: MouseEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY)
      console.log('[Drawing] document click — elementFromPoint:', el?.tagName, el?.className, el === canvas ? '(IS CANVAS)' : '(NOT canvas)')
    }
    document.addEventListener('click', debugClick, true)

    const onMouseDown = (e: MouseEvent) => {
      console.log('[Drawing] mousedown', { button: e.button, x: e.clientX, y: e.clientY, target: e.target })
      if (e.button !== 0) return
      e.preventDefault()
      isDrawingRef.current = true
      const point = { x: e.clientX, y: e.clientY }
      lastPointRef.current = point

      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.beginPath()
        ctx.arc(point.x, point.y, 2, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(255, 50, 30, 0.9)'
        ctx.fill()
        setHasStrokes(true)
      }
    }

    const onMouseMove = (e: MouseEvent) => {
      if (!isDrawingRef.current || !lastPointRef.current) return
      const currentPoint = { x: e.clientX, y: e.clientY }
      drawLine(lastPointRef.current, currentPoint)
      lastPointRef.current = currentPoint
      setHasStrokes(true)
    }

    const onMouseUp = () => {
      if (!isDrawingRef.current) return
      console.log('[Drawing] mouseup — stroke complete')
      isDrawingRef.current = false
      lastPointRef.current = null
      // Save canvas immediately so "Drawing attached" shows right away
      const dataUrl = canvas.toDataURL('image/webp', 0.95)
      console.log('[Drawing] quick-save on stroke end, length:', dataUrl.length)
      saveDrawing(dataUrl)
    }

    canvas.addEventListener('mousedown', onMouseDown)
    canvas.addEventListener('mousemove', onMouseMove)
    canvas.addEventListener('mouseup', onMouseUp)
    window.addEventListener('mouseup', onMouseUp)

    return () => {
      console.log('[Drawing] pencilMode OFF — removing listeners')
      document.removeEventListener('click', debugClick, true)
      canvas.removeEventListener('mousedown', onMouseDown)
      canvas.removeEventListener('mousemove', onMouseMove)
      canvas.removeEventListener('mouseup', onMouseUp)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [pencilMode, drawLine])

  return (
    <canvas
      ref={canvasRef}
      className={styles.overlay}
      data-active={pencilMode}
    />
  )
}
