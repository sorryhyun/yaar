import { errMsg } from '@bundled/yaar';
import { canvasToSource, dragToSourceRect, sourceToCanvasScale } from '../core/geometry';
import { cloneMask, createMask, recount, stampDisc, stampLine, type Mask } from '../core/mask';
import {
  brushSize,
  dispatch,
  doc,
  drawColor,
  drawSize,
  eraser,
  magicWandAt,
  selectMode,
  setStatus,
  setTool,
  tool,
} from '../store';

export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number };

export interface PointerDeps {
  canvas: () => HTMLCanvasElement | undefined;
  overlay: () => HTMLCanvasElement | undefined;
  setDragRect: (rect: Rect | null) => void;
  setDragging: (value: boolean) => void;
  bumpLiveTick: () => void;
}

export interface PointerHandlers {
  onPointerDown: (e: PointerEvent) => void;
  onPointerMove: (e: PointerEvent) => void;
  onPointerUp: (e: PointerEvent) => void;
  /**
   * The scratch mask a lasso drag mutates in place. Kept out of the Doc until
   * the pointer lifts, so one drag is one undo step rather than one per frame.
   * The overlay effect reads it to paint the in-progress selection.
   */
  workMask: () => Mask | null;
}

export function createPointerHandlers(deps: PointerDeps): PointerHandlers {
  let workMask: Mask | null = null;
  let strokePoints: Point[] | null = null;
  let lastCanvasPt: Point | null = null;
  let dragStart: Point | null = null;

  function canvasPoint(e: PointerEvent): Point {
    const canvas = deps.canvas()!;
    const rect = canvas.getBoundingClientRect();
    // Client px -> canvas backing-store px.
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  function toSource(p: Point): Point {
    const canvas = deps.canvas()!;
    return canvasToSource(doc()!, canvas.width, canvas.height, p.x, p.y);
  }

  /**
   * Canvas px per source px. Brush sizes are authored in on-screen pixels and
   * converted through this, so a 12px brush looks 12px wide whatever the zoom —
   * while the stored stroke stays in source space and exports at full res.
   */
  function sourceScale(): number {
    const canvas = deps.canvas()!;
    return sourceToCanvasScale(doc()!, canvas.width, canvas.height) || 1;
  }

  function paintLive(from: Point, to: Point) {
    const r = brushSize() / 2 / sourceScale();
    stampLine(workMask!, from.x, from.y, to.x, to.y, r, selectMode() === 'subtract' ? 0 : 1);
    deps.bumpLiveTick();
  }

  /** Live brush feedback, drawn straight onto the overlay in canvas space. */
  function strokeLive(a: Point, b: Point) {
    const ctx = deps.overlay()?.getContext('2d');
    if (!ctx) return;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1, drawSize());
    ctx.strokeStyle = eraser() ? 'rgba(255,255,255,0.55)' : drawColor();
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
  }

  function onPointerDown(e: PointerEvent) {
    const d = doc();
    const t = tool();
    const canvas = deps.canvas();
    if (!d || !canvas || t === 'none') return;
    canvas.setPointerCapture(e.pointerId);
    const p = canvasPoint(e);
    const s = toSource(p);

    if (t === 'crop') {
      dragStart = p;
      deps.setDragRect({ x: p.x, y: p.y, w: 0, h: 0 });
      return;
    }

    if (t === 'wand') {
      try {
        magicWandAt(s.x, s.y);
      } catch (err) {
        setStatus(errMsg(err));
      }
      return;
    }

    if (t === 'lasso') {
      deps.setDragging(true);
      // Subtract starts from the current selection; add and replace both build
      // up from it too, so a replace-mode drag is additive within one stroke.
      workMask = d.selection ? cloneMask(d.selection) : createMask(d.base.w, d.base.h);
      if (selectMode() === 'replace' && d.selection) workMask.data.fill(0);
      stampDisc(workMask, s.x, s.y, brushSize() / 2 / sourceScale(), selectMode() === 'subtract' ? 0 : 1);
      lastCanvasPt = p;
      deps.bumpLiveTick();
      return;
    }

    if (t === 'draw') {
      deps.setDragging(true);
      strokePoints = [s];
      lastCanvasPt = p;
      strokeLive(p, p);
    }
  }

  function onPointerMove(e: PointerEvent) {
    const t = tool();
    if (!deps.canvas() || !doc()) return;
    const p = canvasPoint(e);

    if (t === 'crop' && dragStart) {
      deps.setDragRect({
        x: Math.min(dragStart.x, p.x),
        y: Math.min(dragStart.y, p.y),
        w: Math.abs(p.x - dragStart.x),
        h: Math.abs(p.y - dragStart.y),
      });
      return;
    }

    if (t === 'lasso' && workMask && lastCanvasPt) {
      paintLive(toSource(lastCanvasPt), toSource(p));
      lastCanvasPt = p;
      return;
    }

    if (t === 'draw' && strokePoints && lastCanvasPt) {
      strokePoints.push(toSource(p));
      strokeLive(lastCanvasPt, p);
      lastCanvasPt = p;
    }
  }

  function onPointerUp(e: PointerEvent) {
    const d = doc();
    const t = tool();
    const canvas = deps.canvas();
    if (!canvas || !d) return;
    canvas.releasePointerCapture(e.pointerId);
    const p = canvasPoint(e);

    if (t === 'crop' && dragStart) {
      const start = dragStart;
      dragStart = null;
      deps.setDragRect(null);
      // Ignore an accidental click — a few pixels is not a crop.
      if (Math.abs(p.x - start.x) < 4 || Math.abs(p.y - start.y) < 4) return;
      dispatch({ type: 'crop', rect: dragToSourceRect(d, canvas.width, canvas.height, start, p) });
      setTool('none');
      return;
    }

    if (t === 'lasso' && workMask) {
      const finished = recount(workMask);
      workMask = null;
      lastCanvasPt = null;
      deps.setDragging(false);
      dispatch({ type: 'setSelection', mask: finished });
      setStatus(
        finished.count
          ? `Selection: ${finished.count.toLocaleString()} px`
          : 'Selection cleared.',
      );
      return;
    }

    if (t === 'draw' && strokePoints) {
      const points = strokePoints;
      strokePoints = null;
      lastCanvasPt = null;
      deps.setDragging(false);
      dispatch({
        type: 'draw',
        stroke: {
          color: drawColor(),
          size: Math.max(1, drawSize() / sourceScale()),
          erase: eraser(),
          points,
        },
      });
    }
  }

  return { onPointerDown, onPointerMove, onPointerUp, workMask: () => workMask };
}
