/**
 * Document-level mouse tracking for a shell drag (window move, window resize), owning
 * both halves of the gesture's global state: the `mousemove`/`mouseup` listeners, and the
 * `yaar-dragging` class on `<html>`.
 *
 * Both belong to the same owner because both are released by the same event, and the
 * gesture's end is not guaranteed to happen. A drag ends at `mouseup` — but the component
 * that started it can be unmounted first, by an agent's `window.close`, Ctrl+W, a monitor
 * switch or a RESYNC snapshot that drops the window. The `mouseup` handler then never
 * runs, and `html.yaar-dragging iframe { pointer-events: none }` — which the shell needs
 * so an app iframe does not swallow the drag's mousemove — stays on for the rest of the
 * session. Every app on every monitor renders and none of them can be clicked, with
 * nothing on screen to say why. Unmount cleanup has to release the class, not just the
 * listeners, and it is here rather than in the caller so neither can be forgotten.
 *
 * The class is only removed if this tracker still had listeners attached, i.e. a gesture
 * really was in flight. A window closing while a *different* window is mid-drag must not
 * pull the class out from under that drag.
 */
import { useCallback, useEffect, useRef } from 'react';
import { DRAGGING_CSS_CLASS } from '@/constants/layout';

type ListenerEntry = { move: (e: MouseEvent) => void; up: (e: MouseEvent) => void };

export function useMouseTracking() {
  const listenersRef = useRef<ListenerEntry[]>([]);

  useEffect(() => {
    const listeners = listenersRef;
    return () => {
      if (listeners.current.length === 0) return;
      for (const { move, up } of listeners.current) {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      }
      listeners.current = [];
      document.documentElement.classList.remove(DRAGGING_CSS_CLASS);
    };
  }, []);

  /**
   * Attach one gesture's listeners. Returns the cleanup the `mouseup` handler calls; the
   * unmount effect above is the fallback for when that handler never runs.
   */
  return useCallback((moveHandler: ListenerEntry['move'], upHandler: ListenerEntry['up']) => {
    const entry: ListenerEntry = { move: moveHandler, up: upHandler };
    listenersRef.current.push(entry);
    document.addEventListener('mousemove', moveHandler);
    document.addEventListener('mouseup', upHandler);

    return () => {
      document.removeEventListener('mousemove', moveHandler);
      document.removeEventListener('mouseup', upHandler);
      listenersRef.current = listenersRef.current.filter((e) => e !== entry);
    };
  }, []);
}
