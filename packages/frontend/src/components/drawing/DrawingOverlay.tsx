/**
 * DrawingOverlay - Full-screen canvas for freehand drawing.
 *
 * Users can Ctrl+LeftDrag to draw on the screen.
 * The drawing is saved and sent with the next message.
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

export function DrawingOverlay() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [ctrlHeld, setCtrlHeld] = useState(false)
  const [hasStrokes, setHasStrokes] = useState(false)
  const saveDrawing = useDesktopStore(state => state.saveDrawing)
  const hasDrawing = useDesktopStore(state => state.hasDrawing)

  // Use refs to avoid stale closure issues in mouse handlers
  const isDrawingRef = useRef(false)
  const lastPointRef = useRef<Point | null>(null)

  // Track Ctrl key state globally
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Control') setCtrlHeld(true)
    }
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Control') setCtrlHeld(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [])

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
      // Save current drawing
      const tempCanvas = document.createElement('canvas')
      tempCanvas.width = canvas.width
      tempCanvas.height = canvas.height
      const tempCtx = tempCanvas.getContext('2d')
      if (tempCtx) {
        tempCtx.drawImage(canvas, 0, 0)
      }

      // Resize
      canvas.width = window.innerWidth
      canvas.height = window.innerHeight

      // Restore drawing
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
    ctx.strokeStyle = 'rgba(255, 100, 50, 0.8)'
    ctx.lineWidth = 3
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.stroke()
  }, [])

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    // Only start drawing with Ctrl+LeftClick
    if (!e.ctrlKey || e.button !== 0) return

    e.preventDefault()
    isDrawingRef.current = true
    const point = { x: e.clientX, y: e.clientY }
    lastPointRef.current = point

    // Draw initial dot so first click is visible
    const canvas = canvasRef.current
    if (canvas) {
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.beginPath()
        ctx.arc(point.x, point.y, 1.5, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(255, 100, 50, 0.8)'
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

  // Capture screen with drawing overlay
  const captureScreenWithDrawing = useCallback(async () => {
    const drawingCanvas = canvasRef.current
    if (!drawingCanvas) return

    try {
      // Capture the screen content (excluding the drawing overlay)
      const screenshot = await html2canvas(document.body, {
        ignoreElements: (element) => element === drawingCanvas,
        useCORS: true,
        logging: false,
        scale: 1,
      })

      // Create a composite canvas
      const compositeCanvas = document.createElement('canvas')
      compositeCanvas.width = screenshot.width
      compositeCanvas.height = screenshot.height
      const ctx = compositeCanvas.getContext('2d')

      if (ctx) {
        // Draw screenshot first
        ctx.drawImage(screenshot, 0, 0)
        // Draw annotations on top
        ctx.drawImage(drawingCanvas, 0, 0)
        // Save the composite
        const dataUrl = compositeCanvas.toDataURL('image/png')
        saveDrawing(dataUrl)
      }
    } catch (error) {
      console.error('Failed to capture screen:', error)
      // Fallback to just the drawing
      const dataUrl = drawingCanvas.toDataURL('image/png')
      saveDrawing(dataUrl)
    }
  }, [saveDrawing])

  const handleMouseUp = useCallback(() => {
    if (!isDrawingRef.current) return

    isDrawingRef.current = false
    lastPointRef.current = null

    // Capture screen with drawing annotations
    captureScreenWithDrawing()
  }, [captureScreenWithDrawing])

  // Handle mouse leaving the window while drawing
  useEffect(() => {
    const handleGlobalMouseUp = () => {
      if (isDrawingRef.current) {
        isDrawingRef.current = false
        lastPointRef.current = null
        captureScreenWithDrawing()
      }
    }

    window.addEventListener('mouseup', handleGlobalMouseUp)
    return () => window.removeEventListener('mouseup', handleGlobalMouseUp)
  }, [captureScreenWithDrawing])

  return (
    <canvas
      ref={canvasRef}
      className={styles.overlay}
      data-ctrl-held={ctrlHeld}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    />
  )
}
