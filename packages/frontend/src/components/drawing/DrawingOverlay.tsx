/**
 * DrawingOverlay - Full-screen canvas for freehand drawing.
 *
 * Two drawing modes:
 *   1. Pencil mode (click pencil button) — left-click drag to draw. Escape to exit.
 *   2. Right-click drag (always active) — right-click drag anywhere to draw freehand
 *      lines. The native context menu is always suppressed.
 *
 * Cross-window drawing: when a right-click drag starts (on the desktop or inside an
 * iframe), the overlay enables pointer-events so it captures ALL subsequent mouse
 * events above iframes, allowing seamless strokes across window boundaries.
 *
 * The saved image includes a screenshot of the current screen with annotations on top,
 * captured at send time via captureMonitorScreenshot().
 */
import { useRef, useState, useEffect, useCallback } from 'react';
import { useDesktopStore } from '@/store';
import { iframeMessages } from '@/lib/iframeMessageRouter';
import { registerDrawingCanvas } from '@/lib/captureMonitorScreenshot';
import styles from '@/styles/drawing/DrawingOverlay.module.css';

interface Point {
  x: number;
  y: number;
}

const DRAG_THRESHOLD = 5;

export function DrawingOverlay() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hasStrokes, setHasStrokes] = useState(false);
  const pencilMode = useDesktopStore((state) => state.pencilMode);
  const setPencilMode = useDesktopStore((state) => state.setPencilMode);
  const saveDrawing = useDesktopStore((state) => state.saveDrawing);
  const hasDrawing = useDesktopStore((state) => state.hasDrawing);

  const isDrawingRef = useRef(false);
  const lastPointRef = useRef<Point | null>(null);
  const hasStrokesRef = useRef(false);

  // Right-click drawing refs — shared between desktop-initiated and
  // iframe-initiated drags (unified tracking).
  const rightDrawingRef = useRef(false);
  const rightStartRef = useRef<Point | null>(null);
  const rightMovedRef = useRef(false);
  const rightLastPointRef = useRef<Point | null>(null);

  hasStrokesRef.current = hasStrokes;

  // Register/unregister drawing canvas for screenshot capture
  useEffect(() => {
    registerDrawingCanvas(canvasRef.current);
    return () => registerDrawingCanvas(null);
  }, []);

  // Clear canvas when drawing is consumed (hasDrawing: true → false)
  const prevHasDrawingRef = useRef(false);
  useEffect(() => {
    if (prevHasDrawingRef.current && !hasDrawing) {
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          setHasStrokes(false);
        }
      }
    }
    prevHasDrawingRef.current = hasDrawing;
  }, [hasDrawing]);

  // Resize canvas to match window size
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = canvas.width;
      tempCanvas.height = canvas.height;
      const tempCtx = tempCanvas.getContext('2d');
      if (tempCtx) {
        tempCtx.drawImage(canvas, 0, 0);
      }

      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;

      const ctx = canvas.getContext('2d');
      if (ctx && tempCtx) {
        ctx.drawImage(tempCanvas, 0, 0);
      }
    };

    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  const drawLine = useCallback((from: Point, to: Point) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.strokeStyle = 'rgba(255, 50, 30, 0.9)';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  }, []);

  // Save raw canvas strokes (for immediate "Drawing attached" feedback).
  // The full monitor composite is captured later at send time.
  const saveStrokesSnapshot = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dataUrl = canvas.toDataURL('image/webp', 1.0);
    saveDrawing(dataUrl);
  }, [saveDrawing]);

  // Enable pointer-events on the overlay canvas so it intercepts all mouse
  // events above iframes, allowing seamless cross-window strokes.
  const capturePointerEvents = useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas) canvas.style.pointerEvents = 'auto';
  }, []);

  // Release pointer-events back to default (CSS controls via data-active).
  const releasePointerEvents = useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas) canvas.style.pointerEvents = '';
  }, []);

  // Exit pencil mode
  const exitPencilMode = useCallback(() => {
    setPencilMode(false);
  }, [setPencilMode]);

  // Escape to exit pencil mode
  useEffect(() => {
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && useDesktopStore.getState().pencilMode) {
        exitPencilMode();
      }
    };
    window.addEventListener('keyup', handleKeyUp);
    return () => window.removeEventListener('keyup', handleKeyUp);
  }, [exitPencilMode]);

  // Pencil mode lifecycle: blur on enter
  const prevPencilMode = useRef(false);
  useEffect(() => {
    if (pencilMode && !prevPencilMode.current) {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    }
    if (!pencilMode && prevPencilMode.current) {
      isDrawingRef.current = false;
      lastPointRef.current = null;
    }
    prevPencilMode.current = pencilMode;
  }, [pencilMode]);

  // Native event listeners for pencil mode (left-click drawing).
  useEffect(() => {
    if (!pencilMode) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      isDrawingRef.current = true;
      const point = { x: e.clientX, y: e.clientY };
      lastPointRef.current = point;

      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.beginPath();
        ctx.arc(point.x, point.y, 2, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 50, 30, 0.9)';
        ctx.fill();
        setHasStrokes(true);
      }
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!isDrawingRef.current || !lastPointRef.current) return;
      const currentPoint = { x: e.clientX, y: e.clientY };
      drawLine(lastPointRef.current, currentPoint);
      lastPointRef.current = currentPoint;
      setHasStrokes(true);
    };

    const onMouseUp = () => {
      if (!isDrawingRef.current) return;
      isDrawingRef.current = false;
      lastPointRef.current = null;
      saveStrokesSnapshot();
    };

    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseup', onMouseUp);
    window.addEventListener('mouseup', onMouseUp);

    return () => {
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [pencilMode, drawLine, saveStrokesSnapshot]);

  // Right-click freehand drawing (always active, even outside pencil mode).
  // Uses a 5px drag threshold so accidental micro-movements are ignored.
  // Native context menu is always suppressed.
  //
  // On mousedown we capture pointer-events on the overlay canvas so that
  // mouse events stay with the parent even when the cursor enters an iframe.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 2) return;
      rightDrawingRef.current = true;
      rightMovedRef.current = false;
      rightStartRef.current = { x: e.clientX, y: e.clientY };
      rightLastPointRef.current = { x: e.clientX, y: e.clientY };
      capturePointerEvents();
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!rightDrawingRef.current || !rightStartRef.current) return;
      const dx = e.clientX - rightStartRef.current.x;
      const dy = e.clientY - rightStartRef.current.y;
      if (!rightMovedRef.current && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD)
        return;

      rightMovedRef.current = true;

      const currentPoint = { x: e.clientX, y: e.clientY };
      if (rightLastPointRef.current) {
        drawLine(rightLastPointRef.current, currentPoint);
      }
      rightLastPointRef.current = currentPoint;
      setHasStrokes(true);
    };

    const onMouseUp = () => {
      if (!rightDrawingRef.current) return;
      const wasDragged = rightMovedRef.current;
      rightDrawingRef.current = false;
      rightStartRef.current = null;
      rightMovedRef.current = false;
      rightLastPointRef.current = null;
      releasePointerEvents();

      if (wasDragged) {
        saveStrokesSnapshot();
      }
    };

    // Always suppress the native context menu.
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };

    window.addEventListener('mousedown', onMouseDown, { capture: true });
    window.addEventListener('mousemove', onMouseMove, { capture: true });
    window.addEventListener('mouseup', onMouseUp, { capture: true });
    window.addEventListener('contextmenu', onContextMenu, { capture: true });

    return () => {
      window.removeEventListener('mousedown', onMouseDown, { capture: true });
      window.removeEventListener('mousemove', onMouseMove, { capture: true });
      window.removeEventListener('mouseup', onMouseUp, { capture: true });
      window.removeEventListener('contextmenu', onContextMenu, { capture: true });
    };
  }, [drawLine, saveStrokesSnapshot, capturePointerEvents, releasePointerEvents]);

  // Iframe right-click drawing support — iframes forward pointer events via
  // postMessage (yaar:arrow-drag-start/move/end) with setPointerCapture, so
  // events keep flowing even after the cursor exits the iframe. All drawing
  // for iframe-initiated drags flows through this postMessage bridge.
  useEffect(() => {
    const offStart = iframeMessages.on('yaar:arrow-drag-start', (ctx) => {
      if (!ctx.source) return;
      const { x, y } = ctx.source.toViewport(ctx.data.clientX ?? 0, ctx.data.clientY ?? 0);
      rightDrawingRef.current = true;
      rightMovedRef.current = false;
      rightStartRef.current = { x, y };
      rightLastPointRef.current = { x, y };
      // No capturePointerEvents — the iframe's setPointerCapture ensures
      // continuous event delivery; all drawing goes through this bridge.
    });

    const offMove = iframeMessages.on('yaar:arrow-drag-move', (ctx) => {
      if (!ctx.source || !rightDrawingRef.current) return;
      const { x, y } = ctx.source.toViewport(ctx.data.clientX ?? 0, ctx.data.clientY ?? 0);
      if (!rightStartRef.current) return;
      const dx = x - rightStartRef.current.x;
      const dy = y - rightStartRef.current.y;
      if (!rightMovedRef.current && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD)
        return;

      rightMovedRef.current = true;
      const currentPoint = { x, y };
      if (rightLastPointRef.current) {
        drawLine(rightLastPointRef.current, currentPoint);
      }
      rightLastPointRef.current = currentPoint;
      setHasStrokes(true);
    });

    const offEnd = iframeMessages.on('yaar:arrow-drag-end', (_ctx) => {
      // If the native mouseup handler already cleaned up, ignore.
      if (!rightDrawingRef.current) return;
      const wasDragged = rightMovedRef.current;
      rightDrawingRef.current = false;
      rightStartRef.current = null;
      rightMovedRef.current = false;
      rightLastPointRef.current = null;

      if (wasDragged) {
        saveStrokesSnapshot();
      }
    });

    return () => {
      offStart();
      offMove();
      offEnd();
    };
  }, [drawLine, saveStrokesSnapshot]);

  return <canvas ref={canvasRef} className={styles.overlay} data-active={pencilMode} />;
}
