/**
 * PhoneGestures - the phone shell's edge gestures.
 *
 * Two of them, recognised two different ways:
 *
 * - **Swipe in from the left or right edge** switches monitor. This one needs a real
 *   element over the page, because on a phone the screen is usually a full-screen card
 *   and an app card is an iframe — a touch inside it never reaches this document. The
 *   gutters are `EDGE_GUTTER_PX` wide and only exist while there is more than one
 *   monitor, so the cost is paid only where there is something to pay it for. A touch
 *   in the gutter that turns out to be a tap is replayed to whatever was underneath.
 * - **Pull down from the top** opens the notification shade. Nothing is needed for this
 *   one: the top of a phone screen is a card's title bar or the home grid, both of them
 *   shell DOM, so a `document` listener sees the touch. It consumes nothing — the
 *   gesture either fires or the tap goes where it was going anyway.
 *
 * The palette's own pull-up is not here; it lives on the handle in `CommandPalette`,
 * which is already the bottom edge of the screen.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useDesktopStore } from '@/store';
import { EDGE_GUTTER_PX, edgeZone, stepMonitorIndex, swipeDirection } from '@/lib/gestures';
import styles from '@/styles/desktop/PhoneGestures.module.css';

/** How far a drag has to travel before the shell says which monitor it is heading for. */
const PREVIEW_AFTER_PX = 24;

export function PhoneGestures() {
  const isMobile = useDesktopStore((s) => s.formFactor === 'mobile');
  const monitors = useDesktopStore(useShallow((s) => s.monitors));
  const activeMonitorId = useDesktopStore((s) => s.activeMonitorId);
  const switchMonitorBy = useDesktopStore((s) => s.switchMonitorBy);

  /** The monitor the in-flight swipe would land on, shown while the finger is down. */
  const [preview, setPreview] = useState<{ side: 'left' | 'right'; label: string } | null>(null);

  const dragStart = useRef<{ x: number; y: number } | null>(null);

  // Pull down from the top edge — document-level, so it sees the card title bar and the
  // home grid without covering either.
  useEffect(() => {
    if (!isMobile) return;
    let start: { x: number; y: number } | null = null;

    const onTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      // A second finger means a pinch or a zoom, not a shade pull.
      if (!touch || e.touches.length > 1) {
        start = null;
        return;
      }
      const zone = edgeZone(touch.clientX, touch.clientY, globalThis.innerWidth);
      start = zone === 'top' ? { x: touch.clientX, y: touch.clientY } : null;
    };

    const onTouchEnd = (e: TouchEvent) => {
      const from = start;
      start = null;
      const touch = e.changedTouches[0];
      if (!from || !touch) return;
      if (swipeDirection(touch.clientX - from.x, touch.clientY - from.y) !== 'down') return;
      const state = useDesktopStore.getState();
      // Already showing something from an edge: the pull has nowhere to go.
      if (state.notificationShadeOpen || state.paletteSheetOpen) return;
      state.setNotificationShadeOpen(true);
    };

    document.addEventListener('touchstart', onTouchStart, true);
    document.addEventListener('touchend', onTouchEnd, true);
    return () => {
      document.removeEventListener('touchstart', onTouchStart, true);
      document.removeEventListener('touchend', onTouchEnd, true);
    };
  }, [isMobile]);

  /** The label of the monitor `delta` steps away, or null at the end of the list. */
  const neighbour = useCallback(
    (delta: number): string | null => {
      const at = monitors.findIndex((m) => m.id === activeMonitorId);
      if (at === -1) return null;
      const next = stepMonitorIndex(at, monitors.length, delta);
      return next === null ? null : monitors[next].label;
    },
    [monitors, activeMonitorId],
  );

  const onGutterTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    dragStart.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
  }, []);

  const onGutterTouchMove = useCallback(
    (e: React.TouchEvent) => {
      const from = dragStart.current;
      const touch = e.touches[0];
      if (!from || !touch) return;
      const dx = touch.clientX - from.x;
      const dy = touch.clientY - from.y;
      if (Math.abs(dx) < PREVIEW_AFTER_PX || Math.abs(dx) < Math.abs(dy)) {
        setPreview(null);
        return;
      }
      // Dragging right pulls the desktop right, which brings the monitor on its left
      // into view — the same direction sense as a page of a book.
      const label = neighbour(dx > 0 ? -1 : 1);
      setPreview(label ? { side: dx > 0 ? 'left' : 'right', label } : null);
    },
    [neighbour],
  );

  const onGutterTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      const from = dragStart.current;
      dragStart.current = null;
      setPreview(null);
      const touch = e.changedTouches[0];
      if (!from || !touch) return;
      const direction = swipeDirection(touch.clientX - from.x, touch.clientY - from.y);
      if (direction === 'right' || direction === 'left') {
        switchMonitorBy(direction === 'right' ? -1 : 1);
        return;
      }
      // Not a swipe, so it was a tap on whatever the gutter is covering — the left edge
      // of a home-screen icon, a title bar button. Hand it over rather than eat it.
      replayTap(e.currentTarget as HTMLElement, touch.clientX, touch.clientY);
    },
    [switchMonitorBy],
  );

  if (!isMobile) return null;

  return (
    <>
      {monitors.length > 1 &&
        (['left', 'right'] as const).map((side) => (
          <div
            key={side}
            className={styles.gutter}
            data-side={side}
            // Width comes from the constant the recogniser uses, so the band that
            // catches the touch and the band that qualifies it are the same band.
            style={{ width: EDGE_GUTTER_PX }}
            onTouchStart={onGutterTouchStart}
            onTouchMove={onGutterTouchMove}
            onTouchEnd={onGutterTouchEnd}
          />
        ))}
      {preview && (
        <div className={styles.preview} data-side={preview.side}>
          {preview.label}
        </div>
      )}
    </>
  );
}

/**
 * Send a tap that landed on a gutter to the element below it.
 *
 * `elementFromPoint` would answer with the gutter itself, so the gutter is taken out of
 * hit-testing for the length of the call. An iframe is skipped: a synthetic click on the
 * frame element does nothing for the document inside it, and pretending otherwise would
 * only swallow the tap a second time.
 */
function replayTap(gutter: HTMLElement, x: number, y: number): void {
  const previous = gutter.style.pointerEvents;
  gutter.style.pointerEvents = 'none';
  const below = document.elementFromPoint(x, y);
  gutter.style.pointerEvents = previous;
  if (below instanceof HTMLElement && below.tagName !== 'IFRAME') below.click();
}
