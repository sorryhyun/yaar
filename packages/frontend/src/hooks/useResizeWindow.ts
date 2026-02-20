/**
 * Hook for window resize from edges and corners.
 */
import { useCallback, useState } from 'react';
import type { WindowBounds } from '@yaar/shared';

interface UseResizeWindowOptions {
  windowId: string;
  bounds: WindowBounds;
  userResizeWindow: (windowId: string, w: number, h: number, x?: number, y?: number) => void;
  queueBoundsUpdate: (windowId: string) => void;
  listenersRef: React.RefObject<
    Array<{ move: (e: MouseEvent) => void; up: (e: MouseEvent) => void }>
  >;
}

export function useResizeWindow({
  windowId,
  bounds,
  userResizeWindow,
  queueBoundsUpdate,
  listenersRef,
}: UseResizeWindowOptions) {
  const [isResizing, setIsResizing] = useState(false);

  const handleResizeStart = useCallback(
    (direction: string, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsResizing(true);
      document.documentElement.classList.add('yaar-dragging');

      const startBounds = { ...bounds };
      const startMouseX = e.clientX;
      const startMouseY = e.clientY;

      const resizeTop = direction.includes('n');
      const resizeBottom = direction.includes('s');
      const resizeLeft = direction.includes('w');
      const resizeRight = direction.includes('e');

      const TASKBAR_H = 36;

      const handleMouseMove = (e: MouseEvent) => {
        const dx = e.clientX - startMouseX;
        const dy = e.clientY - startMouseY;
        const vh = globalThis.innerHeight;
        const vw = globalThis.innerWidth;

        let newX = startBounds.x;
        let newY = startBounds.y;
        let newW = startBounds.w;
        let newH = startBounds.h;

        if (resizeRight) newW = startBounds.w + dx;
        if (resizeLeft) {
          newW = startBounds.w - dx;
          newX = startBounds.x + dx;
        }
        if (resizeBottom) newH = startBounds.h + dy;
        if (resizeTop) {
          newH = startBounds.h - dy;
          newY = startBounds.y + dy;
        }

        // Enforce minimums
        if (newW < 200) {
          if (resizeLeft) newX = startBounds.x + startBounds.w - 200;
          newW = 200;
        }
        if (newH < 150) {
          if (resizeTop) newY = startBounds.y + startBounds.h - 150;
          newH = 150;
        }

        // Clamp: top edge can't go above viewport
        if (newY < 0) {
          newH += newY;
          newY = 0;
        }
        // Clamp: bottom edge can't go below viewport minus taskbar
        const maxH = vh - TASKBAR_H - newY;
        if (newH > maxH) newH = maxH;
        // Clamp: right edge within viewport
        if (newX + newW > vw) newW = vw - newX;
        // Clamp: left edge within viewport
        if (newX < 0) {
          newW += newX;
          newX = 0;
        }

        // Re-enforce minimums after clamping
        if (newW < 200) newW = 200;
        if (newH < 150) newH = 150;

        const posChanged = resizeLeft || resizeTop;
        userResizeWindow(
          windowId,
          newW,
          newH,
          posChanged ? newX : undefined,
          posChanged ? newY : undefined,
        );
      };

      const entry = { move: handleMouseMove, up: handleMouseUp };
      function handleMouseUp() {
        setIsResizing(false);
        document.documentElement.classList.remove('yaar-dragging');
        queueBoundsUpdate(windowId);
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        listenersRef.current = listenersRef.current.filter((e) => e !== entry);
      }

      listenersRef.current.push(entry);
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [windowId, bounds, userResizeWindow, queueBoundsUpdate, listenersRef],
  );

  return { isResizing, handleResizeStart };
}
