/**
 * DrawingOverlay - Full-screen canvas for freehand drawing.
 *
 * Users can Ctrl+LeftDrag to draw on the screen.
 * The drawing is saved and sent with the next message.
 */
import { useRef, useState, useEffect, useCallback } from 'react'
import { useDesktopStore } from '@/store'
import styles from '@/styles/DrawingOverlay.module.css'

interface Point {
  x: number
  y: number
}

export function DrawingOverlay() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [isDrawing, setIsDrawing] = useState(false)
  const [lastPoint, setLastPoint] = useState<Point | null>(null)
  const [hasStrokes, setHasStrokes] = useState(false)
  const saveDrawing = useDesktopStore(state => state.saveDrawing)
  const hasDrawing = useDesktopStore(state => state.hasDrawing)

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
    setIsDrawing(true)
    setLastPoint({ x: e.clientX, y: e.clientY })
  }, [])

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !lastPoint) return

    const currentPoint = { x: e.clientX, y: e.clientY }
    drawLine(lastPoint, currentPoint)
    setLastPoint(currentPoint)
    setHasStrokes(true)
  }, [isDrawing, lastPoint, drawLine])

  const handleMouseUp = useCallback(() => {
    if (!isDrawing) return

    setIsDrawing(false)
    setLastPoint(null)

    // Save the drawing if we have strokes
    if (hasStrokes) {
      const canvas = canvasRef.current
      if (canvas) {
        const dataUrl = canvas.toDataURL('image/png')
        saveDrawing(dataUrl)
      }
    }
  }, [isDrawing, hasStrokes, saveDrawing])

  // Handle mouse leaving the window while drawing
  useEffect(() => {
    const handleGlobalMouseUp = () => {
      if (isDrawing) {
        setIsDrawing(false)
        setLastPoint(null)

        if (hasStrokes) {
          const canvas = canvasRef.current
          if (canvas) {
            const dataUrl = canvas.toDataURL('image/png')
            saveDrawing(dataUrl)
          }
        }
      }
    }

    window.addEventListener('mouseup', handleGlobalMouseUp)
    return () => window.removeEventListener('mouseup', handleGlobalMouseUp)
  }, [isDrawing, hasStrokes, saveDrawing])

  return (
    <canvas
      ref={canvasRef}
      className={styles.overlay}
      data-drawing={isDrawing}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    />
  )
}
