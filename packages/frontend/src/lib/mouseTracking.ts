/**
 * Shared utility for registering mouse move/up listeners with cleanup tracking.
 * Used by useDragWindow and useResizeWindow to avoid duplicated listener management.
 */

type ListenerEntry = { move: (e: MouseEvent) => void; up: (e: MouseEvent) => void };

/**
 * Register mousemove and mouseup listeners on document, tracking them in a ref
 * for cleanup. Returns a cleanup function that removes the listeners.
 */
export function registerMouseTracking(
  moveHandler: (e: MouseEvent) => void,
  upHandler: (e: MouseEvent) => void,
  listenersRef: React.RefObject<ListenerEntry[]>,
): () => void {
  const entry: ListenerEntry = { move: moveHandler, up: upHandler };
  listenersRef.current.push(entry);
  document.addEventListener('mousemove', moveHandler);
  document.addEventListener('mouseup', upHandler);

  return () => {
    document.removeEventListener('mousemove', moveHandler);
    document.removeEventListener('mouseup', upHandler);
    listenersRef.current = listenersRef.current.filter((e) => e !== entry);
  };
}
