/**
 * Hook for window title-bar dragging with snap-to-edge support.
 */
import { useCallback, useRef, useState } from 'react';
import { useDesktopStore } from '@/store';
import { detectSnapZone, getSnapBounds } from '@/lib/snapZones';
import type { WindowBounds } from '@yaar/shared';
import type { WindowModel } from '@/types/state';

interface UseDragWindowOptions {
  windowId: string;
  bounds: WindowBounds;
  variant?: WindowModel['variant'];
  frameless?: boolean;
  userMoveWindow: (windowId: string, x: number, y: number) => void;
  userSnapWindow: (windowId: string, bounds: WindowBounds) => void;
  queueBoundsUpdate: (windowId: string) => void;
  listenersRef: React.RefObject<
    Array<{ move: (e: MouseEvent) => void; up: (e: MouseEvent) => void }>
  >;
}

export function useDragWindow({
  windowId,
  bounds,
  variant,
  frameless,
  userMoveWindow,
  userSnapWindow,
  queueBoundsUpdate,
  listenersRef,
}: UseDragWindowOptions) {
  const [isDragging, setIsDragging] = useState(false);
  const [snapPreviewBounds, setSnapPreviewBounds] = useState<WindowBounds | null>(null);
  const dragOffset = useRef({ x: 0, y: 0 });

  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsDragging(true);
      document.documentElement.classList.add('yaar-dragging');

      const isStandard = !variant || variant === 'standard';
      const canSnap = isStandard && !frameless;

      // Unsnap: if window has previousBounds (snapped) or is maximized, restore original size under cursor
      const store = useDesktopStore.getState();
      const currentWin = store.windows[windowId];
      if (currentWin && (currentWin.maximized || currentWin.previousBounds) && isStandard) {
        const prev = currentWin.previousBounds ?? currentWin.bounds;
        const restoredW = prev.w;
        const restoredH = prev.h;
        // Center restored window horizontally under cursor, keep cursor at titlebar y
        const restoredX = e.clientX - restoredW / 2;
        const restoredY = e.clientY - 18; // middle of titlebar
        useDesktopStore.setState((s) => {
          const win = s.windows[windowId];
          if (win) {
            win.bounds = { x: restoredX, y: Math.max(0, restoredY), w: restoredW, h: restoredH };
            win.maximized = false;
            win.previousBounds = undefined;
          }
        });
        dragOffset.current = {
          x: e.clientX - restoredX,
          y: e.clientY - Math.max(0, restoredY),
        };
      } else {
        dragOffset.current = {
          x: e.clientX - bounds.x,
          y: e.clientY - bounds.y,
        };
      }

      const TITLEBAR_H = 36;
      const TASKBAR_H = 36;
      const yClamp = !variant || variant === 'standard' ? TITLEBAR_H : 0;

      const handleMouseMove = (e: MouseEvent) => {
        const vw = globalThis.innerWidth;
        const vh = globalThis.innerHeight;

        let newX = e.clientX - dragOffset.current.x;
        let newY = e.clientY - dragOffset.current.y;

        // Keep title bar reachable: at least 100px of width visible horizontally
        const currentW = useDesktopStore.getState().windows[windowId]?.bounds.w ?? 400;
        newX = Math.max(-(currentW - 100), Math.min(newX, vw - 100));
        // Top: can't go above viewport; Bottom: title bar must stay above taskbar
        newY = Math.max(0, Math.min(newY, vh - TASKBAR_H - yClamp));

        userMoveWindow(windowId, newX, newY);

        // Snap zone detection (standard windows only)
        if (canSnap) {
          const zone = detectSnapZone(e.clientX, e.clientY);
          setSnapPreviewBounds(zone ? getSnapBounds(zone) : null);
        }
      };

      const entry = { move: handleMouseMove, up: handleMouseUp };
      function handleMouseUp(e: MouseEvent) {
        setIsDragging(false);
        document.documentElement.classList.remove('yaar-dragging');

        // Snap on drop
        if (canSnap) {
          const zone = detectSnapZone(e.clientX, e.clientY);
          if (zone) {
            userSnapWindow(windowId, getSnapBounds(zone));
          }
          setSnapPreviewBounds(null);
        }

        queueBoundsUpdate(windowId);
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        listenersRef.current = listenersRef.current.filter((e) => e !== entry);
      }

      listenersRef.current.push(entry);
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [
      windowId,
      bounds.x,
      bounds.y,
      bounds.w,
      bounds.h,
      variant,
      frameless,
      userMoveWindow,
      userSnapWindow,
      queueBoundsUpdate,
      listenersRef,
    ],
  );

  return { isDragging, snapPreviewBounds, handleDragStart };
}
