/**
 * useArrowDrag — Unified right-click arrow drag gesture.
 *
 * Handles two event sources:
 *   1. Native mousedown (button 2) on the parent document
 *   2. Forwarded mousedown/mousemove/mouseup from same-origin iframes
 *      (via iframeMessageRouter: yaar:arrow-drag-start/move/end)
 *
 * Returns the arrow line state for SVG rendering and a mousedown handler
 * for the desktop surface's onMouseDown prop.
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { useDesktopStore } from '@/store';
import { getRawWindowId } from '@/store/helpers';
import { iframeMessages } from '@/lib/iframeMessageRouter';

export interface ArrowLine {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

const DRAG_THRESHOLD = 5;

/**
 * Identify the desktop element under a point (window, app icon, shortcut, or
 * bare desktop). Skips the arrow drag overlay itself.
 */
function describePointTarget(x: number, y: number): string {
  const els = document.elementsFromPoint(x, y);
  for (const el of els) {
    if ('arrowOverlay' in ((el as HTMLElement).dataset ?? {})) continue;
    const winEl = (el as HTMLElement).closest<HTMLElement>('[data-window-id]');
    if (winEl) {
      const wid = winEl.dataset.windowId!;
      const win = useDesktopStore.getState().windows[wid];
      const title = win?.title ?? wid;
      return `window "${title}" (id: ${getRawWindowId(wid)})`;
    }
    const appEl = (el as HTMLElement).closest<HTMLElement>('[data-app-id]');
    if (appEl) return `app "${appEl.dataset.appId}"`;
    const shortcutEl = (el as HTMLElement).closest<HTMLElement>('[data-shortcut-id]');
    if (shortcutEl) return `shortcut "${shortcutEl.dataset.shortcutId}"`;
  }
  return `desktop (${Math.round(x)}, ${Math.round(y)})`;
}

/** Send the drag gesture to the AI. */
function emitDragGesture(startX: number, startY: number, endX: number, endY: number) {
  const from = describePointTarget(startX, startY);
  const to = describePointTarget(endX, endY);
  useDesktopStore
    .getState()
    .queueGestureMessage(`<ui:drag>\n  from: ${from}\n  to: ${to}\n</ui:drag>`);
}

// ─── Overlay helpers ───────────────────────────────────────────────────

function createOverlay(): HTMLDivElement {
  const overlay = document.createElement('div');
  overlay.dataset.arrowOverlay = '';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:99997;';
  document.body.appendChild(overlay);
  return overlay;
}

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

// ─── Hook ──────────────────────────────────────────────────────────────

export function useArrowDrag() {
  const [arrowDrag, setArrowDrag] = useState<ArrowLine | null>(null);
  const active = useRef(false);

  // Native drag: document-level mousemove/mouseup listeners
  const nativeListeners = useRef<{
    move: (e: MouseEvent) => void;
    up: (e: MouseEvent) => void;
  } | null>(null);

  // Iframe drag: start coords (iframe resolved per-event via router)
  const iframeDragStart = useRef<{ startX: number; startY: number } | null>(null);
  const iframeOverlay = useRef<HTMLDivElement | null>(null);

  // ── Native path: right-click mousedown on the parent document ──

  const handleArrowDragStart = useCallback((e: React.MouseEvent) => {
    if (e.button !== 2) return;

    const startX = e.clientX;
    const startY = e.clientY;
    active.current = false;

    const overlay = createOverlay();

    const handleMouseMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!active.current && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      active.current = true;
      setArrowDrag({ startX, startY, endX: ev.clientX, endY: ev.clientY });
    };

    const handleMouseUp = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      nativeListeners.current = null;
      overlay.remove();

      if (active.current) {
        emitDragGesture(startX, startY, ev.clientX, ev.clientY);
        setArrowDrag(null);
        suppressNextContextMenu();
      }
      active.current = false;
    };

    // Clean up any stale listeners from a previous interrupted drag
    if (nativeListeners.current) {
      document.removeEventListener('mousemove', nativeListeners.current.move);
      document.removeEventListener('mouseup', nativeListeners.current.up);
    }
    nativeListeners.current = { move: handleMouseMove, up: handleMouseUp };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, []);

  // ── Iframe path: forwarded events via iframeMessageRouter ──

  useEffect(() => {
    const offStart = iframeMessages.on('yaar:arrow-drag-start', (ctx) => {
      if (!ctx.source) return;

      const { x, y } = ctx.source.toViewport(ctx.data.clientX ?? 0, ctx.data.clientY ?? 0);
      iframeDragStart.current = { startX: x, startY: y };
      active.current = false;
      iframeOverlay.current = createOverlay();
    });

    const offMove = iframeMessages.on('yaar:arrow-drag-move', (ctx) => {
      if (!ctx.source || !iframeDragStart.current) return;
      const { startX, startY } = iframeDragStart.current;

      const { x: endX, y: endY } = ctx.source.toViewport(
        ctx.data.clientX ?? 0,
        ctx.data.clientY ?? 0,
      );

      const dx = endX - startX;
      const dy = endY - startY;
      if (!active.current && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;

      active.current = true;
      setArrowDrag({ startX, startY, endX, endY });
    });

    const offEnd = iframeMessages.on('yaar:arrow-drag-end', (ctx) => {
      if (!iframeDragStart.current) return;

      iframeOverlay.current?.remove();
      iframeOverlay.current = null;

      if (active.current && ctx.source) {
        const { startX, startY } = iframeDragStart.current;
        const { x: endX, y: endY } = ctx.source.toViewport(
          ctx.data.clientX ?? 0,
          ctx.data.clientY ?? 0,
        );
        emitDragGesture(startX, startY, endX, endY);
        setArrowDrag(null);
      }

      active.current = false;
      iframeDragStart.current = null;
    });

    return () => {
      offStart();
      offMove();
      offEnd();
      iframeOverlay.current?.remove();
    };
  }, []);

  // Cleanup native listeners on unmount
  useEffect(() => {
    return () => {
      if (nativeListeners.current) {
        document.removeEventListener('mousemove', nativeListeners.current.move);
        document.removeEventListener('mouseup', nativeListeners.current.up);
      }
    };
  }, []);

  return { arrowDrag, handleArrowDragStart } as const;
}
