/**
 * MonitorTabs - Monitor switcher + "new monitor" button.
 *
 * On a desktop it is its own row directly above the command palette's input bar — the
 * mirror of the window taskbar row below it. On a phone the bottom of the screen is a
 * collapsed sheet with one row to spare, so both rows move into the pull-down shade
 * instead (see `NotificationShade`), which is where the phone already keeps everything
 * the desktop shows around the edges.
 *
 * A monitor is closed differently on each. The desktop chip carries an × that hover
 * brings out; a phone has no hover, so an × there is either always on — a delete button
 * sitting permanently under the thumb that switches monitors — or invisible. So the
 * phone drops it and **flicks the chip up** instead, the gesture every phone already
 * uses for "get rid of this card". It is the chip that moves, so the target and the
 * thing being thrown away are the same object, and letting go short of the commit puts
 * it back rather than doing something irreversible.
 */
import { useCallback, useEffect, useRef } from 'react';
import { DEFAULT_MONITOR_ID } from '@yaar/shared';
import { useDesktopStore } from '@/store';
import { SWIPE_MIN_PX, dragAxis, shouldCommitDrag } from '@/lib/gestures';
import styles from '@/styles/taskbar/Taskbar.module.css';

/** How long the chip takes to finish the throw, or to come back, once the finger lifts. */
const LIFT_SETTLE_MS = 180;

/**
 * How long a thrown chip is given to actually go away.
 *
 * `removeMonitor` is a request: the chip is unmounted by the `MONITORS` answer, not by
 * the gesture. If no answer comes — a closed socket, a server that refused — the chip is
 * put back, because a monitor that is still there must not be left as a hole in the row.
 */
const LIFT_RESTORE_MS = 1200;

/** The chip under the finger: what it is, where the touch began, and how it is going. */
interface Lift {
  id: string;
  el: HTMLElement;
  x: number;
  y: number;
  at: number;
  /** Locked once the drag says which way it is going; `null` while it is still a tap. */
  axis: 'x' | 'y' | null;
}

export function MonitorTabs() {
  const monitors = useDesktopStore((s) => s.monitors);
  const isMobile = useDesktopStore((s) => s.formFactor === 'mobile');
  const activeMonitorId = useDesktopStore((s) => s.activeMonitorId);
  const maxMonitors = useDesktopStore((s) => s.maxMonitors);
  const switchMonitor = useDesktopStore((s) => s.switchMonitor);
  const createMonitor = useDesktopStore((s) => s.createMonitor);
  const removeMonitor = useDesktopStore((s) => s.removeMonitor);

  const lift = useRef<Lift | null>(null);
  const restore = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Put a chip back where it was — the end of a throw that missed, and of one that
   *  was never answered. */
  const settle = useCallback((el: HTMLElement) => {
    el.style.transform = '';
    el.style.opacity = '';
  }, []);

  const onLiftStart = useCallback((e: React.TouchEvent<HTMLElement>, id: string) => {
    const touch = e.touches[0];
    if (!touch) return;
    const el = e.currentTarget;
    // Whatever the last gesture left on it: a chip mid-settle is being grabbed again.
    el.style.transition = '';
    lift.current = {
      id,
      el,
      x: touch.clientX,
      y: touch.clientY,
      at: performance.now(),
      axis: null,
    };
  }, []);

  const onLiftMove = useCallback((e: React.TouchEvent<HTMLElement>) => {
    const l = lift.current;
    const touch = e.touches[0];
    if (!l || !touch) return;
    const dx = touch.clientX - l.x;
    const dy = touch.clientY - l.y;
    if (!l.axis) {
      const axis = dragAxis(dx, dy);
      if (!axis) return;
      // Sideways is the row scrolling and downward is nothing at all: hand the touch
      // back rather than holding on to a drag this chip has no use for. `touch-action:
      // pan-x` on the chip is what lets the browser keep the horizontal one.
      if (axis === 'x' || dy > 0) {
        lift.current = null;
        return;
      }
      l.axis = axis;
    }
    // Upwards only, and one-to-one: the chip is the thing being thrown, so it has to
    // stay under the finger. It fades as it goes, which is the only warning there is
    // that letting go here would close the monitor.
    const travel = Math.min(0, dy);
    l.el.style.transform = `translateY(${travel}px)`;
    l.el.style.opacity = String(Math.max(0.25, 1 - Math.abs(travel) / SWIPE_MIN_PX));
  }, []);

  const onLiftEnd = useCallback(
    (e: React.TouchEvent<HTMLElement>) => {
      const l = lift.current;
      lift.current = null;
      const touch = e.changedTouches[0];
      if (!l || !touch || !l.axis) return;
      // This touch was a drag, not a tap; the click the browser would send after it
      // would switch to the monitor that is on its way out.
      if (e.cancelable) e.preventDefault();

      const dy = touch.clientY - l.y;
      l.el.style.transition = `transform ${LIFT_SETTLE_MS}ms ease-out, opacity ${LIFT_SETTLE_MS}ms ease-out`;
      if (!(dy < 0 && shouldCommitDrag(dy, performance.now() - l.at))) {
        settle(l.el);
        return;
      }
      l.el.style.transform = 'translateY(-120%)';
      l.el.style.opacity = '0';
      removeMonitor(l.id);
      if (restore.current) clearTimeout(restore.current);
      restore.current = setTimeout(() => {
        restore.current = null;
        settle(l.el);
      }, LIFT_RESTORE_MS);
    },
    [removeMonitor, settle],
  );

  useEffect(
    () => () => {
      if (restore.current) clearTimeout(restore.current);
      restore.current = null;
    },
    [],
  );

  // A desktop hides the switcher until there is something to switch between — the row
  // sits against the input bar, where a lone chip is chrome for a choice nobody has.
  // The phone keeps it: its row is a section of the shade, headed "Monitors", and a
  // heading over nothing but a "+" reads as a list that failed to load rather than as
  // a list of one. The chip is also the only thing on a phone that says which monitor
  // the pan is currently on.
  const showMonitorTabs = monitors.length > 1 || isMobile;
  const showNewMonitor = monitors.length < maxMonitors;

  if (!showMonitorTabs && !showNewMonitor) return null;

  return (
    <div className={styles.monitorBar}>
      {showMonitorTabs && (
        <div className={styles.monitorTabs}>
          {monitors.map((m) => {
            // The first monitor is the session's own and the server refuses to delete
            // it, so it does not move: a chip that followed the finger and came back
            // every time would be promising something that is never going to happen.
            const liftable = isMobile && m.id !== DEFAULT_MONITOR_ID;
            return (
              <button
                key={m.id}
                className={`${styles.monitorTab} ${m.id === activeMonitorId ? styles.monitorTabActive : ''}`}
                data-liftable={liftable || undefined}
                onClick={() => switchMonitor(m.id)}
                onTouchStart={liftable ? (e) => onLiftStart(e, m.id) : undefined}
                onTouchMove={liftable ? onLiftMove : undefined}
                onTouchEnd={liftable ? onLiftEnd : undefined}
                title={m.label}
              >
                {isMobile ? shortLabel(m.label) : m.label}
                {!isMobile && (
                  <span
                    className={styles.monitorClose}
                    role="button"
                    aria-label={`Close ${m.label}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      removeMonitor(m.id);
                    }}
                  >
                    &#x2715;
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {showNewMonitor && (
        <button
          className={styles.newMonitorButton}
          onClick={() => createMonitor()}
          title="Create new monitor"
        >
          +
        </button>
      )}
    </div>
  );
}

/**
 * What a chip says on a phone. The shade heads this row "Monitors" already, so the word
 * on every chip is that heading repeated across a 412px screen; the number is the part
 * that tells them apart. The full label stays in `title` — and a renamed monitor has no
 * prefix to drop, so it is shown whole.
 */
function shortLabel(label: string): string {
  return label.replace(/^monitor\s+/i, '') || label;
}
