/**
 * DrawingOverlay - Full-screen canvas for freehand drawing.
 *
 * Two drawing modes:
 *   1. Pencil mode (click pencil button) — left-click drag to draw. Escape to exit.
 *   2. Right-click drag (always active) — right-click drag anywhere to draw freehand
 *      lines. Simple right-click (no drag) still shows the context menu.
 *
 * The saved image includes a screenshot of the current screen with annotations on top.
 */
import { useRef, useState, useEffect, useCallback } from 'react';
import html2canvas from 'html2canvas';
import { useDesktopStore } from '@/store';
import { iframeMessages } from '@/lib/iframeMessageRouter';
import styles from '@/styles/drawing/DrawingOverlay.module.css';

interface Point {
  x: number;
  y: number;
}

const DRAG_THRESHOLD = 5;

function suppressNextContextMenu() {
  document.addEventListener(
    'contextmenu',
    (cm) => {
      cm.preventDefault();
      cm.stopPropagation();
    },
    { capture: true, once: true },
  );
}

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

  // Right-click drawing refs (separate from pencil mode's left-click drawing)
  const rightDrawingRef = useRef(false);
  const rightStartRef = useRef<Point | null>(null);
  const rightMovedRef = useRef(false);
  const rightLastPointRef = useRef<Point | null>(null);

  hasStrokesRef.current = hasStrokes;

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

  // Capture screen with drawing overlay
  const captureScreenWithDrawing = useCallback(async () => {
    const drawingCanvas = canvasRef.current;
    if (!drawingCanvas) return;

    try {
      const dpr = window.devicePixelRatio || 1;
      const screenshot = await html2canvas(document.body, {
        ignoreElements: (element) => element === drawingCanvas,
        useCORS: true,
        logging: false,
        scale: dpr,
      });

      const compositeCanvas = document.createElement('canvas');
      compositeCanvas.width = screenshot.width;
      compositeCanvas.height = screenshot.height;
      const ctx = compositeCanvas.getContext('2d');

      if (ctx) {
        ctx.drawImage(screenshot, 0, 0);
        ctx.drawImage(
          drawingCanvas,
          0,
          0,
          drawingCanvas.width,
          drawingCanvas.height,
          0,
          0,
          screenshot.width,
          screenshot.height,
        );
        const dataUrl = compositeCanvas.toDataURL('image/webp', 0.95);
        saveDrawing(dataUrl);
      }
    } catch {
      const dataUrl = drawingCanvas.toDataURL('image/webp', 0.95);
      saveDrawing(dataUrl);
    }
  }, [saveDrawing]);

  // Exit pencil mode — capture is handled by the lifecycle effect below
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

  // Pencil mode lifecycle: blur on enter, capture on exit
  const prevPencilMode = useRef(false);
  useEffect(() => {
    if (pencilMode && !prevPencilMode.current) {
      // Entering pencil mode — blur active element so canvas receives events
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    }
    if (!pencilMode && prevPencilMode.current) {
      isDrawingRef.current = false;
      lastPointRef.current = null;
      if (hasStrokesRef.current && useDesktopStore.getState().hasDrawing) {
        // Upgrade with screenshot composite (only if drawing wasn't already consumed)
        captureScreenWithDrawing();
      }
    }
    prevPencilMode.current = pencilMode;
  }, [pencilMode, captureScreenWithDrawing]);

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
      // Save canvas immediately so "Drawing attached" shows right away
      const dataUrl = canvas.toDataURL('image/webp', 0.95);
      saveDrawing(dataUrl);
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
  }, [pencilMode, drawLine, saveDrawing]);

  // Right-click freehand drawing (always active, even outside pencil mode).
  // Uses a 5px drag threshold — simple right-click still triggers context menu.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 2) return;
      rightDrawingRef.current = true;
      rightMovedRef.current = false;
      rightStartRef.current = { x: e.clientX, y: e.clientY };
      rightLastPointRef.current = { x: e.clientX, y: e.clientY };
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!rightDrawingRef.current || !rightStartRef.current) return;
      const dx = e.clientX - rightStartRef.current.x;
      const dy = e.clientY - rightStartRef.current.y;
      if (!rightMovedRef.current && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD)
        return;

      if (!rightMovedRef.current) {
        rightMovedRef.current = true;
        suppressNextContextMenu();
      }

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

      if (wasDragged) {
        // Quick-save canvas, then upgrade with composite screenshot
        const dataUrl = canvas.toDataURL('image/webp', 0.95);
        saveDrawing(dataUrl);
        captureScreenWithDrawing();
      }
    };

    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [drawLine, saveDrawing, captureScreenWithDrawing]);

  // Iframe right-click drawing support — iframes forward right-click events
  // via postMessage (yaar:arrow-drag-start/move/end) since native mouse events
  // don't cross iframe boundaries.
  useEffect(() => {
    let iframeRightStart: Point | null = null;
    let iframeRightMoved = false;
    let iframeRightLastPoint: Point | null = null;

    const offStart = iframeMessages.on('yaar:arrow-drag-start', (ctx) => {
      if (!ctx.source) return;
      const { x, y } = ctx.source.toViewport(ctx.data.clientX ?? 0, ctx.data.clientY ?? 0);
      iframeRightStart = { x, y };
      iframeRightMoved = false;
      iframeRightLastPoint = { x, y };
    });

    const offMove = iframeMessages.on('yaar:arrow-drag-move', (ctx) => {
      if (!ctx.source || !iframeRightStart) return;
      const { x, y } = ctx.source.toViewport(ctx.data.clientX ?? 0, ctx.data.clientY ?? 0);
      const dx = x - iframeRightStart.x;
      const dy = y - iframeRightStart.y;
      if (!iframeRightMoved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD)
        return;

      iframeRightMoved = true;
      const currentPoint = { x, y };
      if (iframeRightLastPoint) {
        drawLine(iframeRightLastPoint, currentPoint);
      }
      iframeRightLastPoint = currentPoint;
      setHasStrokes(true);
    });

    const offEnd = iframeMessages.on('yaar:arrow-drag-end', (_ctx) => {
      if (!iframeRightStart) return;
      const wasDragged = iframeRightMoved;
      iframeRightStart = null;
      iframeRightMoved = false;
      iframeRightLastPoint = null;

      if (wasDragged) {
        const canvas = canvasRef.current;
        if (canvas) {
          const dataUrl = canvas.toDataURL('image/webp', 0.95);
          saveDrawing(dataUrl);
          captureScreenWithDrawing();
        }
      }
    });

    return () => {
      offStart();
      offMove();
      offEnd();
    };
  }, [drawLine, saveDrawing, captureScreenWithDrawing]);

  return <canvas ref={canvasRef} className={styles.overlay} data-active={pencilMode} />;
}
