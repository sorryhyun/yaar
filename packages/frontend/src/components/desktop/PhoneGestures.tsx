/**
 * PhoneGestures - the phone shell's touch gestures.
 *
 * Two of them, both recognised by one `document`-level state machine:
 *
 * - **Drag sideways** pans between monitors, and the desktop follows the finger: the
 *   monitor being left slides out, the one being uncovered slides in behind it. That
 *   animation is the reason the gesture no longer has to start at an edge — a pan that
 *   shows where it is going can afford to begin anywhere the shell owns (the wallpaper,
 *   the icon grid, the status bar), because the user can see what it is doing and let go
 *   if it was not what they meant. The side gutters stay for the case the shell does not
 *   own: a phone window is a full-screen card and an app card is an iframe, so a touch
 *   inside one reaches no listener in this document at all.
 * - **Pull down from the top** opens the notification shade. That needs nothing over the
 *   page either: the top of a phone screen is a card's title bar or the home grid, both
 *   of them shell DOM.
 *
 * Neither gesture consumes a touch it did not use. A drag that turns out to be vertical
 * is handed straight back to the page, and a touch in a gutter that turns out to be a tap
 * is replayed to whatever the gutter was covering.
 *
 * The palette's own pull-up is not here; it lives on the handle in `CommandPalette`,
 * which is already the bottom edge of the screen.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_MONITOR_ID } from '@yaar/shared';
import { useDesktopStore } from '@/store';
import {
  EDGE_GUTTER_PX,
  PEEK_SETTLE_MS,
  PEEK_TITLE_LIMIT,
  dragAxis,
  edgeZone,
  peekOffset,
  shouldCommitPeek,
  stepMonitorIndex,
  swipeDirection,
} from '@/lib/gestures';
import { WINDOW_ID_DATA_ATTR } from '@/constants/layout';
import { resolveWallpaper } from '@/constants/appearance';
import styles from '@/styles/desktop/PhoneGestures.module.css';

/** The CSS var the desktop and the peek panel both translate by. */
const PEEK_X_VAR = '--monitor-peek-x';
/** Published beside it so the settle transition and the settle timer cannot disagree. */
const PEEK_MS_VAR = '--monitor-peek-ms';

/** The monitor a pan is heading for, and enough of it to put on screen behind the drag. */
interface Peek {
  id: string;
  label: string;
  titles: string[];
  /** Which edge it is coming in from — left when the finger is dragging right. */
  side: 'left' | 'right';
}

/** What one touch has told us so far. Lives in a ref: a pan must not re-render per frame. */
interface Drag {
  x: number;
  y: number;
  at: number;
  /** Locked on the first frame that says which way this is going. */
  axis: 'x' | 'y' | null;
  /** The pull-down is only on offer from the top band. */
  fromTop: boolean;
  /** Started in a side gutter, so a tap here belongs to whatever is underneath. */
  fromGutter: boolean;
  /** Whether this touch is allowed to pan at all — decided from where it landed. */
  canPan: boolean;
}

export function PhoneGestures() {
  const isMobile = useDesktopStore((s) => s.formFactor === 'mobile');
  const monitorCount = useDesktopStore((s) => s.monitors.length);
  const wallpaper = useDesktopStore((s) => s.wallpaper);

  /** The monitor sliding in behind the drag, rendered while the finger is down. */
  const [peek, setPeek] = useState<Peek | null>(null);
  // The handlers are plain DOM listeners and read this rather than the closed-over state,
  // which would be a frame behind by the time the next touchmove asked.
  const peekRef = useRef<Peek | null>(null);
  const setPeekNow = useCallback((next: Peek | null) => {
    peekRef.current = next;
    setPeek(next);
  }, []);

  const drag = useRef<Drag | null>(null);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isMobile) return;
    const root = document.documentElement;

    /** Put the desktop back where it was and forget the pan, mid-flight or finished. */
    const clearPeek = () => {
      if (settle.current) clearTimeout(settle.current);
      settle.current = null;
      root.removeAttribute('data-monitor-peek');
      root.style.removeProperty(PEEK_X_VAR);
      root.style.removeProperty(PEEK_MS_VAR);
      setPeekNow(null);
    };

    /** The monitor `delta` steps away, with a look at what is open on it. */
    const neighbour = (delta: number, side: 'left' | 'right'): Peek | null => {
      const { monitors, activeMonitorId, windows } = useDesktopStore.getState();
      const at = monitors.findIndex((m) => m.id === activeMonitorId);
      if (at === -1) return null;
      const next = stepMonitorIndex(at, monitors.length, delta);
      if (next === null) return null;
      const monitor = monitors[next];
      const titles = Object.values(windows)
        .filter(
          (w) =>
            w != null &&
            !w.minimized &&
            (!w.variant || w.variant === 'standard') &&
            (w.monitorId ?? DEFAULT_MONITOR_ID) === monitor.id,
        )
        .map((w) => w.title)
        .slice(0, PEEK_TITLE_LIMIT);
      return { id: monitor.id, label: monitor.label, titles, side };
    };

    /** Follow the finger: move the desktop, and keep the right neighbour behind it. */
    const trackPan = (dx: number) => {
      // Dragging right pulls the desktop right, which brings the monitor on its left
      // into view — the same direction sense as a page of a book.
      if (dx !== 0) {
        const side = dx > 0 ? 'left' : 'right';
        const current = peekRef.current;
        if (!current || current.side !== side) setPeekNow(neighbour(dx > 0 ? -1 : 1, side));
      }
      // Both of these are per-pan, not per-frame; only the offset below moves.
      if (root.dataset.monitorPeek !== 'dragging') {
        root.dataset.monitorPeek = 'dragging';
        // The settle transition reads its duration from here, so the animation that
        // draws the landing and the timer that commits it cannot disagree.
        root.style.setProperty(PEEK_MS_VAR, `${PEEK_SETTLE_MS}ms`);
      }
      root.style.setProperty(
        PEEK_X_VAR,
        `${peekOffset(dx, peekRef.current !== null, globalThis.innerWidth)}px`,
      );
    };

    /** Let go: run the rest of the slide, then land on whichever monitor won. */
    const finishPan = (dx: number, elapsed: number) => {
      const target = peekRef.current;
      // A drag that reversed past its start is heading back where it came from, and the
      // neighbour on screen is no longer the one it would land on.
      const landing =
        target !== null &&
        (target.side === 'left' ? dx > 0 : dx < 0) &&
        shouldCommitPeek(dx, elapsed)
          ? target
          : null;
      const width = globalThis.innerWidth;
      root.dataset.monitorPeek = 'settling';
      root.style.setProperty(
        PEEK_X_VAR,
        landing ? `${landing.side === 'left' ? width : -width}px` : '0px',
      );
      settle.current = setTimeout(() => {
        // Switch and un-translate in the same tick: React commits the new monitor before
        // the browser paints, so the desktop is never seen at rest showing the old one.
        if (landing) useDesktopStore.getState().switchMonitor(landing.id);
        clearPeek();
      }, PEEK_SETTLE_MS);
    };

    const onTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      // A second finger means a pinch or a zoom, not one of ours. Any pan the first
      // finger had started goes back rather than staying frozen mid-slide.
      if (!touch || e.touches.length > 1) {
        const pending = drag.current;
        drag.current = null;
        if (pending?.axis === 'x' && peekRef.current) finishPan(0, 0);
        return;
      }
      // A touch landing mid-settle takes the pan over rather than fighting it.
      if (settle.current) clearPeek();
      const zone = edgeZone(touch.clientX, touch.clientY, globalThis.innerWidth);
      const state = useDesktopStore.getState();
      const fromGutter = (e.target as Element | null)?.hasAttribute?.('data-phone-gutter') === true;
      drag.current = {
        x: touch.clientX,
        y: touch.clientY,
        at: performance.now(),
        axis: null,
        fromTop: zone === 'top',
        fromGutter,
        canPan:
          state.monitors.length > 1 &&
          !state.cliMode &&
          !state.paletteSheetOpen &&
          !state.notificationShadeOpen &&
          (fromGutter || canPanFrom(e.target)),
      };
    };

    const onTouchMove = (e: TouchEvent) => {
      const d = drag.current;
      const touch = e.touches[0];
      if (!d || !touch) return;
      const dx = touch.clientX - d.x;
      const dy = touch.clientY - d.y;
      if (!d.axis) {
        d.axis = dragAxis(dx, dy);
        if (!d.axis) return;
      }
      if (d.axis !== 'x' || !d.canPan) return;
      // The desktop is under the finger now, so the page must not also scroll under it.
      if (e.cancelable) e.preventDefault();
      trackPan(dx);
    };

    const onTouchEnd = (e: TouchEvent) => {
      const d = drag.current;
      drag.current = null;
      const touch = e.changedTouches[0];
      if (!d) return;
      if (!touch) {
        if (d.axis === 'x' && peekRef.current) finishPan(0, 0);
        return;
      }
      const dx = touch.clientX - d.x;
      const dy = touch.clientY - d.y;

      if (d.axis === 'x' && d.canPan) {
        finishPan(dx, performance.now() - d.at);
        return;
      }
      // No touchmove ever arrived — a browser can coalesce a fast flick into start and
      // end alone. There was nothing to animate, so just go.
      if (!d.axis && d.canPan) {
        const direction = swipeDirection(dx, dy);
        if (direction === 'left' || direction === 'right') {
          useDesktopStore.getState().switchMonitorBy(direction === 'right' ? -1 : 1);
          return;
        }
      }
      if (d.fromTop && swipeDirection(dx, dy) === 'down') {
        const state = useDesktopStore.getState();
        // Already showing something from an edge: the pull has nowhere to go.
        if (!state.notificationShadeOpen && !state.paletteSheetOpen) {
          state.setNotificationShadeOpen(true);
          return;
        }
      }
      // A gutter touch that went nowhere was a tap on whatever the gutter is covering —
      // the left edge of a home-screen icon, a title bar button. Hand it over. A tap
      // wanders, so this asks whether the touch was a swipe rather than whether it held
      // perfectly still: a finger that slipped 12px is still a tap.
      if (d.fromGutter && swipeDirection(dx, dy) === null) replayTap(touch.clientX, touch.clientY);
    };

    const onTouchCancel = () => {
      const d = drag.current;
      drag.current = null;
      if (d?.axis === 'x' && peekRef.current) finishPan(0, 0);
      else if (peekRef.current) clearPeek();
    };

    document.addEventListener('touchstart', onTouchStart, true);
    // Not passive: a pan that has claimed the axis has to stop the page scrolling with it.
    document.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
    document.addEventListener('touchend', onTouchEnd, true);
    document.addEventListener('touchcancel', onTouchCancel, true);
    return () => {
      document.removeEventListener('touchstart', onTouchStart, true);
      document.removeEventListener('touchmove', onTouchMove, true);
      document.removeEventListener('touchend', onTouchEnd, true);
      document.removeEventListener('touchcancel', onTouchCancel, true);
      clearPeek();
    };
  }, [isMobile, setPeekNow]);

  if (!isMobile) return null;

  return (
    <>
      {monitorCount > 1 &&
        (['left', 'right'] as const).map((side) => (
          <div
            key={side}
            className={styles.gutter}
            data-side={side}
            data-phone-gutter=""
            // Width comes from the constant the recogniser uses, so the band that
            // catches the touch and the band that qualifies it are the same band.
            style={{ width: EDGE_GUTTER_PX }}
          />
        ))}
      {peek && (
        <div
          className={styles.peek}
          data-side={peek.side}
          style={{ background: resolveWallpaper(wallpaper) }}
          aria-hidden
        >
          <div className={styles.peekLabel}>{peek.label}</div>
          {peek.titles.length > 0 && (
            <ul className={styles.peekWindows}>
              {peek.titles.map((title, i) => (
                <li key={i} className={styles.peekWindow}>
                  {title}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

/**
 * Whether a touch that landed on `el` is allowed to pan between monitors.
 *
 * The pan may start anywhere the shell owns, and a window is not that: a card is the
 * monitor's *content*, and sliding the desktop out from under something the user is
 * reading is not what the drag meant. A sideways scroller — a tab strip, a row of chips —
 * is refused for the same reason, since it has its own use for a horizontal drag, and
 * `data-no-pan` is the explicit version of the same refusal for the few surfaces that
 * are neither: the palette, the drawing canvas.
 */
function canPanFrom(el: EventTarget | null): boolean {
  for (let node = el instanceof Element ? el : null; node; node = node.parentElement) {
    if (node.hasAttribute(WINDOW_ID_DATA_ATTR) || node.hasAttribute('data-no-pan')) return false;
    // getComputedStyle is the expensive half, so only ask it about elements that have
    // somewhere to scroll in the first place.
    if (node.scrollWidth > node.clientWidth + 1) {
      const overflow = getComputedStyle(node).overflowX;
      if (overflow === 'auto' || overflow === 'scroll') return false;
    }
  }
  return true;
}

/**
 * Send a tap that landed on a gutter to the element below it.
 *
 * `elementFromPoint` would answer with the gutter itself, so the gutters are taken out of
 * hit-testing for the length of the call. An iframe is skipped: a synthetic click on the
 * frame element does nothing for the document inside it, and pretending otherwise would
 * only swallow the tap a second time.
 */
function replayTap(x: number, y: number): void {
  const gutters = [...document.querySelectorAll<HTMLElement>('[data-phone-gutter]')];
  const previous = gutters.map((g) => g.style.pointerEvents);
  for (const gutter of gutters) gutter.style.pointerEvents = 'none';
  const below = document.elementFromPoint(x, y);
  gutters.forEach((gutter, i) => {
    gutter.style.pointerEvents = previous[i];
  });
  if (below instanceof HTMLElement && below.tagName !== 'IFRAME') below.click();
}
