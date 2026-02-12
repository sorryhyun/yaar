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

  // Clear canvas when drawing is consumed
  useEffect(() => {
    if (!hasDrawing && hasStrokes) {
      const canvas = canvasRef.current
      if (canvas) {
        const ctx = canvas.getContext('2d')
        if (ctx) {
          ctx.clearRect(0, 0, canvas.width, canvas.height)
          setHasStrokes(false)
        }
      }
    }
  }, [hasDrawing, hasStrokes])

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
    const drawingCanvas = canvasRef.current
    if (!drawingCanvas) return

    try {
      const dpr = window.devicePixelRatio || 1
      const screenshot = await html2canvas(document.body, {
        ignoreElements: (element) => element === drawingCanvas,
        useCORS: true,
        logging: false,
        scale: dpr,
      })

      const compositeCanvas = document.createElement('canvas')
      compositeCanvas.width = screenshot.width
      compositeCanvas.height = screenshot.height
      const ctx = compositeCanvas.getContext('2d')

      if (ctx) {
        ctx.drawImage(screenshot, 0, 0)
        ctx.drawImage(drawingCanvas, 0, 0, drawingCanvas.width, drawingCanvas.height,
          0, 0, screenshot.width, screenshot.height)
        const dataUrl = compositeCanvas.toDataURL('image/webp', 0.95)
        saveDrawing(dataUrl)
      }
    } catch (error) {
      console.error('Failed to capture screen:', error)
      const dataUrl = drawingCanvas.toDataURL('image/webp', 0.95)
      saveDrawing(dataUrl)
    }
  }, [saveDrawing])

  // Exit pencil mode and capture
  const exitPencilMode = useCallback(() => {
    setPencilMode(false)
    isDrawingRef.current = false
    lastPointRef.current = null
    if (hasStrokesRef.current) {
      captureScreenWithDrawing()
    }
  }, [captureScreenWithDrawing, setPencilMode])

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

  // When pencilMode changes externally (e.g. button)
  const prevPencilMode = useRef(false)
  useEffect(() => {
    if (pencilMode && !prevPencilMode.current) {
      // Entering pencil mode — blur active element so canvas receives events
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur()
      }
    }
    if (prevPencilMode.current && !pencilMode && hasStrokesRef.current) {
      // Exiting pencil mode — capture
      isDrawingRef.current = false
      lastPointRef.current = null
      captureScreenWithDrawing()
    }
    prevPencilMode.current = pencilMode
  }, [pencilMode, captureScreenWithDrawing])

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    isDrawingRef.current = true
    const point = { x: e.clientX, y: e.clientY }
    lastPointRef.current = point

    // Draw initial dot
    const canvas = canvasRef.current
    if (canvas) {
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.beginPath()
        ctx.arc(point.x, point.y, 2, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(255, 50, 30, 0.9)'
        ctx.fill()
        setHasStrokes(true)
      }
    }
  }, [])

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawingRef.current || !lastPointRef.current) return

    const currentPoint = { x: e.clientX, y: e.clientY }
    drawLine(lastPointRef.current, currentPoint)
    lastPointRef.current = currentPoint
    setHasStrokes(true)
  }, [drawLine])

  const handleMouseUp = useCallback(() => {
    if (!isDrawingRef.current) return
    isDrawingRef.current = false
    lastPointRef.current = null
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className={styles.overlay}
      data-active={pencilMode}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    />
  )
}
