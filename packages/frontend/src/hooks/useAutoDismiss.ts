import { useEffect, useRef } from 'react';

/**
 * Manages auto-dismiss timers for a list of items.
 * Creates a timer for each new item; cleans up when items are removed or on unmount.
 */
export function useAutoDismiss<T extends { id: string }>(
  items: T[],
  onDismiss: (id: string) => void,
  getDuration: (item: T) => number,
) {
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    for (const item of items) {
      const duration = getDuration(item);
      // A non-positive/non-finite duration means "never auto-dismiss" — the
      // item persists until the user dismisses it manually (e.g. agent → user
      // direct messages, which have no duration and must be closed via ×).
      if (!(duration > 0 && Number.isFinite(duration))) continue;
      if (!timersRef.current.has(item.id)) {
        const timer = setTimeout(() => {
          onDismiss(item.id);
          timersRef.current.delete(item.id);
        }, duration);
        timersRef.current.set(item.id, timer);
      }
    }

    // Clean up timers for removed items
    const currentIds = new Set(items.map((i) => i.id));
    for (const [id, timer] of timersRef.current) {
      if (!currentIds.has(id)) {
        clearTimeout(timer);
        timersRef.current.delete(id);
      }
    }
  }, [items, onDismiss, getDuration]);

  // Cleanup all timers on unmount
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
    };
  }, []);
}
