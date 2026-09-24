/**
 * PhoneGestures - the phone shell's touch gestures.
 *
 * Two of them, both recognised by one `document`-level state machine:
 *
 * - **Drag sideways** pans between monitors, and the desktop follows the finger: the
 *   monitor being left slides out, the one being uncovered slides in behind it. That
 *   animation is the reason the gesture no longer has to start at an edge — a pan that
 *   shows where it is going can afford to begin anywhere, because the user can see what
 *   it is doing and let go if it was not what they meant. It may begin over a window
 *   too: a phone card is the whole screen, so a pan that stopped at a card's edge was a
 *   pan with nowhere left to start from. What it gives way to is not the card but the
 *   drag the card had a use for — a sideways scroller keeps the direction it can still
 *   scroll in, and hands back the one it cannot. An app card is an iframe, so a touch
 *   inside one reaches no listener here; the frame's own script makes the same decision
 *   and forwards the drag (`APP_MSG.touchPan`). The side gutters stay for a frame that
 *   carries no such script — an external page.
 * - **Pull down** brings down the notification shade — which on a phone is also where the
 *   connection and agent readings live — and it comes down with the finger rather than
 *   after it, for the same reason the pan does: a sheet that appears only once the finger
 *   is up gives the user nothing to aim with and no way to change their mind. Like the
 *   pan it may start anywhere, and for the same reason: it gives way only to a scroll
 *   that still has somewhere to go (`canPullFrom`). The placing is left to CSS through
 *   `lib/shade-pull`, which the shade's own grip writes to as well, so pulling it open and
 *   pushing it shut are one gesture described in one place.
 * - **Pull down again**, on the open shade, clears the active monitor's context. The sheet
 *   stretches instead of following the finger, and uncovers a hint that turns from "pull"
 *   to "release" at `SHADE_CLEAR_PX` — a drag that long has to be meant, which is the
 *   confirmation a destructive gesture needs. It clears only if the finger is still
 *   pulling *down* when it lifts (`shadeClearArmed`): one that has started back up, by
 *   more than a held finger wobbles, has taken the pull back — past the line or not — and
 *   the hint turns back to "pull" to say so. One that cleared stays stretched on "Context
 *   cleared" for `SHADE_CLEAR_HOLD_MS` before springing back, so the gesture shows it
 *   worked rather than looking like one let go short.
 *
 * The strip the pan runs along is wider than the monitor list at both ends. The **CLI**
 * sits one step to the left of the first monitor: `Shift+Tab` is the way into it on a
 * desktop and a phone has no Shift+Tab, so without this the tmux-style view was simply
 * unreachable there. It is the left-hand end of the strip rather than a mode toggle
 * because that is what makes it reversible by the same gesture, in the direction the
 * finger already knows. The right-hand end is a **new monitor**, while the session has
 * room for one: the "+" in the shade is otherwise the only way to make one, and a strip
 * that stopped dead at the last monitor was an end the finger kept running into. What a
 * pan is heading for is named twice while the finger is down — on the surface sliding in,
 * and as a large number held still in the middle of the screen, which is the one that can
 * be read while everything else is moving.
 *
 * Neither gesture consumes a touch it did not use. A drag that turns out to be vertical
 * is handed straight back to the page, and a touch in a gutter that turns out to be a tap
 * is replayed to whatever the gutter was covering.
 *
 * The palette's own pull-up is not here; it lives on the handle in `CommandPalette`,
 * which is already the bottom edge of the screen.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import i18next from 'i18next';
import { APP_MSG, DEFAULT_MONITOR_ID } from '@yaar/shared';
import { useDesktopStore } from '@/store';
import {
  EDGE_GUTTER_PX,
  PEEK_SETTLE_MS,
  PEEK_TITLE_LIMIT,
  dragAxis,
  peekOffset,
  shadeClearArmed,
  shouldCommitDrag,
  stepMonitorIndex,
  swipeDirection,
} from '@/lib/gestures';
import {
  holdShadeClear,
  settleShadeClear,
  settleShadePull,
  trackShadeClear,
  trackShadePull,
} from '@/lib/shade-pull';
import { clearGestureVars, gestureLayerRef, setGestureVar } from '@/lib/gesture-layer';
import { iframeMessages } from '@/lib/iframeMessageRouter';
import { resolveWallpaper } from '@/constants/appearance';
import { monitorNumber, predictNextMonitorLabel } from '@/store/slices/monitorSlice';
import { resetActiveMonitorContext } from '../command-palette/ContextResetButton';
import styles from '@/styles/desktop/PhoneGestures.module.css';

/** The layer the desktop, the CLI panel and the peek panel all belong to. */
const PAN_LAYER = 'monitor-peek';
/** The CSS var the desktop and the peek panel both translate by. */
const PEEK_X_VAR = '--monitor-peek-x';
/** Published beside it so the settle transition and the settle timer cannot disagree. */
const PEEK_MS_VAR = '--monitor-peek-ms';
/**
 * How long a pan onto a new monitor holds the slide while the server mints it. The
 * switch arrives on the `MONITORS` answer, not on the finger lifting, and snapping back to
 * the old desktop in between would show the user the one thing they just left.
 */
const NEW_MONITOR_WAIT_MS = 2000;

/**
 * Where a pan can land: a monitor, the CLI to the left of the first one, a monitor not
 * made yet to the right of the last one, or — from inside the CLI — the desktop it was
 * opened from.
 */
type PanTarget =
  | { kind: 'monitor'; id: string }
  | { kind: 'new' }
  | { kind: 'cli' }
  | { kind: 'desktop' };

/** The surface a pan is heading for, and enough of it to put on screen behind the drag. */
interface Peek {
  target: PanTarget;
  label: string;
  /** Shown large, held still mid-screen: the monitor's number, or `CLI`. */
  badge: string;
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
  /** Whether this touch is allowed to pull the shade down — nothing vertically
   *  scrollable under the finger, and no sheet already up. */
  canPull: boolean;
  /** Whether it is a second pull, on a shade that is already open, that can clear. */
  canClear: boolean;
  /** Started in a side gutter, so a tap here belongs to whatever is underneath. */
  fromGutter: boolean;
  /** Which way this touch may not pan — decided from where it landed. */
  panBlock: PanBlock;
  /** Whether the pan won the direction it set off in. `null` until the axis locks. */
  panning: boolean | null;
}

/**
 * The pan directions a touch is refused, in finger-travel terms: `right` is a drag
 * rightwards, which is the one that uncovers the surface on the left.
 */
interface PanBlock {
  left: boolean;
  right: boolean;
}

const PAN_FREE: PanBlock = { left: false, right: false };
const PAN_BLOCKED: PanBlock = { left: true, right: true };

export function PhoneGestures() {
  const isMobile = useDesktopStore((s) => s.formFactor === 'mobile');
  const wallpaper = useDesktopStore((s) => s.wallpaper);

  /** The surface sliding in behind the drag, rendered while the finger is down. */
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
  /** Whether the finger currently down is the one dragging the shade. */
  const pullingShade = useRef(false);
  const shadeSettle = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Whether the finger down is pulling an open shade further, and whether it is armed. */
  const clearing = useRef<{ armed: boolean; peak: number } | null>(null);
  /** Waiting on the server for the monitor a pan created: how to stop waiting. */
  const newMonitorWait = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!isMobile) return;
    const root = document.documentElement;

    /** Put the desktop back where it was and forget the pan, mid-flight or finished. */
    const clearPeek = () => {
      if (settle.current) clearTimeout(settle.current);
      settle.current = null;
      newMonitorWait.current?.();
      newMonitorWait.current = null;
      root.removeAttribute('data-monitor-peek');
      clearGestureVars(PAN_LAYER);
      setPeekNow(null);
    };

    /** The surface `delta` steps away, with a look at what is open on it. */
    const neighbour = (delta: number, side: 'left' | 'right'): Peek | null => {
      const { monitors, activeMonitorId, maxMonitors, windows, cliMode } =
        useDesktopStore.getState();
      // Inside the CLI the strip has one exit, and it is the way back in: rightwards.
      // Nothing is drawn for it — the desktop is genuinely behind the panel, so the
      // slide uncovers the real thing rather than a picture of it.
      if (cliMode) {
        const active = monitors.find((m) => m.id === activeMonitorId);
        return delta > 0
          ? {
              target: { kind: 'desktop' },
              label: '',
              badge: active ? monitorNumber(active.label) : '',
              titles: [],
              side,
            }
          : null;
      }
      const at = monitors.findIndex((m) => m.id === activeMonitorId);
      if (at === -1) return null;
      const next = stepMonitorIndex(at, monitors.length, delta);
      if (next === null) {
        // Off the left end of the monitor list is not nothing: it is the CLI.
        if (delta < 0 && at === 0) {
          return { target: { kind: 'cli' }, label: 'CLI', badge: 'CLI', titles: [], side };
        }
        // And off the right end is the next monitor, until the session is full.
        const label =
          delta > 0 && at === monitors.length - 1 && predictNextMonitorLabel(monitors, maxMonitors);
        return label
          ? {
              target: { kind: 'new' },
              label: i18next.t('gestures.newMonitor'),
              badge: monitorNumber(label),
              titles: [],
              side,
            }
          : null;
      }
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
      return {
        target: { kind: 'monitor', id: monitor.id },
        label: monitor.label,
        badge: monitorNumber(monitor.label),
        titles,
        side,
      };
    };

    /** Land on whatever the pan chose. The one place a swipe changes what is on screen. */
    const commit = (target: PanTarget) => {
      const state = useDesktopStore.getState();
      if (target.kind === 'cli') state.setCliMode(true);
      else if (target.kind === 'desktop') state.setCliMode(false);
      else if (target.kind === 'new') state.createMonitor();
      else state.switchMonitor(target.id);
    };

    /**
     * Hold the slide where it landed until the monitor the pan asked for is the one on
     * screen — the server mints it and switches this tab to it on its `MONITORS` answer —
     * then let the desktop come back. A server that refused (the session filled up from
     * another tab) or never answered gets the old desktop back after a bounded wait.
     */
    const awaitNewMonitor = () => {
      const from = useDesktopStore.getState().activeMonitorId;
      const unsubscribe = useDesktopStore.subscribe((s) => {
        if (s.activeMonitorId !== from) clearPeek();
      });
      const timer = setTimeout(clearPeek, NEW_MONITOR_WAIT_MS);
      newMonitorWait.current = () => {
        unsubscribe();
        clearTimeout(timer);
      };
    };

    /** Follow the finger: move the desktop, and keep the right neighbour behind it. */
    const trackPan = (dx: number) => {
      // Dragging right pulls the desktop right, which brings the surface on its left
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
        setGestureVar(PAN_LAYER, PEEK_MS_VAR, `${PEEK_SETTLE_MS}ms`);
      }
      setGestureVar(
        PAN_LAYER,
        PEEK_X_VAR,
        `${peekOffset(dx, peekRef.current !== null, globalThis.innerWidth)}px`,
      );
    };

    /** Let go: run the rest of the slide, then land on whichever surface won. */
    const finishPan = (dx: number, elapsed: number) => {
      const target = peekRef.current;
      // A drag that reversed past its start is heading back where it came from, and the
      // neighbour on screen is no longer the one it would land on.
      const landing =
        target !== null &&
        (target.side === 'left' ? dx > 0 : dx < 0) &&
        shouldCommitDrag(dx, elapsed)
          ? target
          : null;
      const width = globalThis.innerWidth;
      root.dataset.monitorPeek = 'settling';
      setGestureVar(
        PAN_LAYER,
        PEEK_X_VAR,
        landing ? `${landing.side === 'left' ? width : -width}px` : '0px',
      );
      settle.current = setTimeout(() => {
        // Switch and un-translate in the same tick: React commits the new surface before
        // the browser paints, so the desktop is never seen at rest showing the old one.
        settle.current = null;
        if (landing) commit(landing.target);
        if (landing?.target.kind === 'new') awaitNewMonitor();
        else clearPeek();
      }, PEEK_SETTLE_MS);
    };

    /** Bring the shade down under the finger, mounting it on the first frame. */
    const trackShade = (dy: number) => {
      if (!pullingShade.current) {
        pullingShade.current = true;
        // Mounting it *is* opening it as far as the rest of the shell is concerned: the
        // sheet is on screen from here on, and a pull that is let go too early takes it
        // back below. That is also what keeps the other gestures off this touch.
        useDesktopStore.getState().setNotificationShadeOpen(true);
      }
      trackShadePull(dy);
    };

    /** Stretch an open shade under a second pull, and say when letting go would clear. */
    const trackClear = (dy: number) => {
      const pull = clearing.current ?? (clearing.current = { armed: false, peak: 0 });
      pull.peak = Math.max(pull.peak, dy);
      // Armed only while still pulling down: past the line *and* not on the way back up,
      // so a pull taken back is cancelled even before it is back above the line.
      const armed = shadeClearArmed(dy, pull.peak);
      trackShadeClear(dy, armed);
      // A tick as it arms — the moment letting go starts to mean something. Where the
      // platform has one; the hint's colour and wording change either way.
      if (armed && !pull.armed) navigator.vibrate?.(10);
      pull.armed = armed;
    };

    /** Let go of a second pull: spring the sheet back, and clear only if it was armed. */
    const finishClear = (dy: number) => {
      const pull = clearing.current;
      clearing.current = null;
      const clear = pull !== null && shadeClearArmed(dy, Math.max(pull.peak, dy));
      // Cleared on the spot, not after the spring: the reset is a delivery that the
      // server acks, and the toast saying so should not wait on an animation.
      if (!clear) {
        shadeSettle.current = settleShadeClear(() => {
          shadeSettle.current = null;
        });
        return;
      }
      resetActiveMonitorContext();
      // Held where the finger left it for a beat before springing back, so the gesture
      // itself says the reset happened — see `SHADE_CLEAR_HOLD_MS`.
      holdShadeClear(
        () => {
          shadeSettle.current = null;
          // The pull was for this; the shade has nothing left to be open for.
          useDesktopStore.getState().setNotificationShadeOpen(false);
        },
        (timer) => (shadeSettle.current = timer),
      );
    };

    /** Let go of a pull: finish the slide, and put the shade away if it lost. */
    const finishShade = (dy: number, elapsed: number) => {
      pullingShade.current = false;
      const open = shouldCommitDrag(dy, elapsed) && dy > 0;
      shadeSettle.current = settleShadePull(open, () => {
        shadeSettle.current = null;
        if (!open) useDesktopStore.getState().setNotificationShadeOpen(false);
      });
    };

    const onTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      // A second finger means a pinch or a zoom, not one of ours. Any pan the first
      // finger had started goes back rather than staying frozen mid-slide.
      if (!touch || e.touches.length > 1) {
        const pending = drag.current;
        drag.current = null;
        if (pending?.axis === 'x' && peekRef.current) finishPan(0, 0);
        else if (pullingShade.current) finishShade(0, 0);
        else if (clearing.current) finishClear(0);
        return;
      }
      // A touch landing mid-settle takes the pan over rather than fighting it.
      if (settle.current || newMonitorWait.current) clearPeek();
      const state = useDesktopStore.getState();
      const fromGutter = (e.target as Element | null)?.hasAttribute?.('data-phone-gutter') === true;
      const sheetUp = state.paletteSheetOpen || state.notificationShadeOpen;
      drag.current = {
        x: touch.clientX,
        y: touch.clientY,
        at: performance.now(),
        axis: null,
        // The shade may be pulled from over a card — which on a phone is most of the
        // screen — so this asks a different question from `panBlockFrom`: not "which
        // way may this pan?" but "would the finger have scrolled something?".
        canPull: !sheetUp && (fromGutter || canPullFrom(e.target)),
        // Only on the shade itself or its backdrop, and not mid-way through the pull that
        // is still bringing it down: an open shade is the one thing a second pull clears.
        canClear:
          state.notificationShadeOpen &&
          !state.paletteSheetOpen &&
          !pullingShade.current &&
          shadeSettle.current === null &&
          isOnShade(e.target) &&
          canPullFrom(e.target),
        fromGutter,
        // No monitor-count test: with the CLI on the end of the strip there is somewhere
        // to go even from a lone monitor, and a direction with nothing in it rubber-bands
        // rather than being refused up front.
        panBlock: sheetUp ? PAN_BLOCKED : fromGutter ? PAN_FREE : panBlockFrom(e.target),
        panning: null,
      };
    };

    const onTouchMove = (e: TouchEvent) => {
      const d = drag.current;
      const touch = e.touches[0];
      if (!d || !touch) return;
      const dx = touch.clientX - d.x;
      const dy = touch.clientY - d.y;
      if (!d.axis) {
        // Claim a downward drag before the browser does. `dragAxis` needs 10px to say
        // which way this is going, and by then Chrome has decided too: it starts
        // scrolling on the first move it is allowed to keep, after which the moves stop
        // being cancelable and the shade would come down over a page sliding under it.
        // Safe to claim this early, because `canPull` has already said that nothing
        // under the finger has anywhere left to scroll upwards to.
        // Only while the move is more down than sideways, so a sideways scroller under a
        // finger that has not decided yet keeps its first frames.
        if ((d.canPull || d.canClear) && dy > 0 && dy >= Math.abs(dx) && e.cancelable) {
          e.preventDefault();
        }
        d.axis = dragAxis(dx, dy);
        if (!d.axis) return;
      }
      if (d.axis === 'y' && d.canClear) {
        // Upwards is not this gesture's — the grip pushes the shade shut — but a second
        // pull already under way follows the finger back up, so it can be taken back.
        if (dy <= 0 && !clearing.current) return;
        if (e.cancelable) e.preventDefault();
        trackClear(dy);
        return;
      }
      if (d.axis === 'y') {
        // Upwards from the top edge is nothing to begin with — there is no shade up there
        // yet to push back — but once one is coming down it follows the finger both ways,
        // so a pull can be taken back without lifting.
        if (!d.canPull || (dy <= 0 && !pullingShade.current)) return;
        if (e.cancelable) e.preventDefault();
        trackShade(dy);
        return;
      }
      // Which way the pan set off decides whether it is ours: a scroller that is already
      // at its right-hand end has nothing to do with a drag that would take it further.
      if (d.panning === null) d.panning = !d.panBlock[dx > 0 ? 'right' : 'left'];
      if (!d.panning) return;
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
        else if (pullingShade.current) finishShade(0, 0);
        else if (clearing.current) finishClear(0);
        return;
      }
      const dx = touch.clientX - d.x;
      const dy = touch.clientY - d.y;

      if (clearing.current) {
        finishClear(dy);
        return;
      }

      if (d.axis === 'x' && d.panning) {
        finishPan(dx, performance.now() - d.at);
        return;
      }
      if (pullingShade.current) {
        finishShade(dy, performance.now() - d.at);
        return;
      }
      // No touchmove ever arrived — a browser can coalesce a fast flick into start and
      // end alone. There was nothing to animate, so just go.
      if (!d.axis) {
        const direction = swipeDirection(dx, dy);
        if ((direction === 'left' || direction === 'right') && !d.panBlock[direction]) {
          const right = direction === 'right';
          const target = neighbour(right ? -1 : 1, right ? 'left' : 'right');
          if (target) {
            commit(target.target);
            return;
          }
        }
      }
      // A pull that never reported a move — a browser can coalesce a fast one into start
      // and end alone — has nothing to animate from, so it just opens.
      if (d.canPull && swipeDirection(dx, dy) === 'down') {
        useDesktopStore.getState().setNotificationShadeOpen(true);
        return;
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
      if (pullingShade.current) finishShade(0, 0);
      if (clearing.current) finishClear(0);
      if (d?.axis === 'x' && peekRef.current) finishPan(0, 0);
      else if (peekRef.current) clearPeek();
    };

    // An app card is an iframe, and a touch inside one reaches none of the listeners
    // above. The frame's own script (iframe-scripts/contextmenu.ts) claims a drag nothing
    // in the app had a use for and hands its travel out here — sideways for the pan,
    // downwards from content already at its top for the shade — so both run the same way
    // from over an app as from over anything else.
    let framePan: { at: number; moved: boolean; axis: 'x' | 'y' } | null = null;
    const offFramePan = iframeMessages.on(APP_MSG.touchPan, ({ data, source }) => {
      if (!source) return;
      const dx = Number(data.dx) || 0;
      const dy = Number(data.dy) || 0;
      if (data.phase === 'start') {
        const { paletteSheetOpen, notificationShadeOpen } = useDesktopStore.getState();
        framePan =
          paletteSheetOpen || notificationShadeOpen
            ? null
            : { at: performance.now(), moved: false, axis: data.axis === 'y' ? 'y' : 'x' };
        if (framePan?.axis === 'x' && (settle.current || newMonitorWait.current)) clearPeek();
        return;
      }
      const pan = framePan;
      if (!pan) return;
      if (data.phase === 'move') {
        pan.moved = true;
        if (pan.axis === 'x') trackPan(dx);
        // As from the shell: a pull follows the finger back up once it is under way.
        else if (dy > 0 || pullingShade.current) trackShade(dy);
        return;
      }
      framePan = null;
      const elapsed = performance.now() - pan.at;
      if (pan.axis === 'y') {
        if (pullingShade.current) finishShade(data.phase === 'cancel' ? 0 : dy, elapsed);
        // A pull that arrived as start and end alone, as in onTouchEnd.
        else if (data.phase === 'end' && swipeDirection(dx, dy) === 'down') {
          useDesktopStore.getState().setNotificationShadeOpen(true);
        }
        return;
      }
      if (data.phase === 'cancel') {
        if (pan.moved) finishPan(0, 0);
        return;
      }
      if (pan.moved) {
        finishPan(dx, elapsed);
        return;
      }
      // A flick that arrived as start and end alone, as in onTouchEnd.
      const direction = swipeDirection(dx, dy);
      if (direction !== 'left' && direction !== 'right') return;
      const right = direction === 'right';
      const target = neighbour(right ? -1 : 1, right ? 'left' : 'right');
      if (target) commit(target.target);
    });

    document.addEventListener('touchstart', onTouchStart, true);
    // Not passive: a pan that has claimed the axis has to stop the page scrolling with it.
    document.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
    document.addEventListener('touchend', onTouchEnd, true);
    document.addEventListener('touchcancel', onTouchCancel, true);
    return () => {
      offFramePan();
      document.removeEventListener('touchstart', onTouchStart, true);
      document.removeEventListener('touchmove', onTouchMove, true);
      document.removeEventListener('touchend', onTouchEnd, true);
      document.removeEventListener('touchcancel', onTouchCancel, true);
      if (shadeSettle.current) clearTimeout(shadeSettle.current);
      shadeSettle.current = null;
      pullingShade.current = false;
      clearPeek();
    };
  }, [isMobile, setPeekNow]);

  if (!isMobile) return null;

  return (
    <>
      {/* Always both, on every phone: the CLI is off the left end of the strip whatever
          the monitor count, and the right gutter is the way back from it. */}
      {(['left', 'right'] as const).map((side) => (
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
      {/* The number, held still while the surfaces slide past behind it — the one thing on
          screen during a pan that can be read without chasing it. */}
      {peek?.badge && (
        <div
          className={styles.badge}
          data-peek-badge=""
          data-new={peek.target.kind === 'new' || undefined}
          data-cli={peek.target.kind === 'cli' || undefined}
          aria-hidden
        >
          <span className={styles.badgeNumber}>{peek.badge}</span>
          {peek.target.kind === 'new' && <span className={styles.badgeCaption}>{peek.label}</span>}
        </div>
      )}
      {peek && peek.target.kind !== 'desktop' && (
        <div
          className={styles.peek}
          data-gesture-layer={PAN_LAYER}
          ref={gestureLayerRef(PAN_LAYER)}
          data-side={peek.side}
          data-cli={peek.target.kind === 'cli' || undefined}
          style={
            peek.target.kind === 'cli' ? undefined : { background: resolveWallpaper(wallpaper) }
          }
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
 * Which way a touch that landed on `el` may not pan.
 *
 * A window used to refuse both directions outright — a card is the monitor's *content*,
 * and sliding the desktop out from under something the user is reading is not what the
 * drag meant. But on a phone the card *is* the screen, so that left the pan startable
 * from the wallpaper and little else: with one window open the gesture was gone, and the
 * 20px gutters were the whole of it. What is worth protecting was never the card, it is
 * the drag something under the finger already had a use for, so that is what is asked
 * now — and per direction, because a sideways scroller only has a use for the drags it
 * can still scroll with. One at its right-hand end keeps the drag that scrolls it back
 * and gives away the one that would take it further, which is the bargain `canPullFrom`
 * makes with a list already at its top. `data-no-pan` and a slider are the outright
 * refusals: the palette, the drawing canvas, and anything whose whole use is a sideways
 * drag that never scrolls.
 */
function panBlockFrom(el: EventTarget | null): PanBlock {
  const block: PanBlock = { left: false, right: false };
  for (let node = el instanceof Element ? el : null; node; node = node.parentElement) {
    if (node.hasAttribute('data-no-pan') || isSlider(node)) return PAN_BLOCKED;
    // getComputedStyle is the expensive half, so only ask it about elements that have
    // somewhere to scroll in the first place.
    if (node.scrollWidth > node.clientWidth + 1) {
      const overflow = getComputedStyle(node).overflowX;
      if (overflow === 'auto' || overflow === 'scroll') {
        // Distance from each end, not which side of zero it sits on: a right-to-left
        // scroller counts down from 0 rather than up from it.
        const at = Math.abs(node.scrollLeft);
        // Dragging right scrolls a scroller back towards its start, so it is the one
        // with something still behind it that keeps that drag.
        if (at > 1) block.right = true;
        if (at < node.scrollWidth - node.clientWidth - 1) block.left = true;
        if (block.left && block.right) return PAN_BLOCKED;
      }
    }
  }
  return block;
}

/** A control a sideways drag is already the way of using, scroller or not. */
function isSlider(node: Element): boolean {
  if (node.getAttribute('role') === 'slider') return true;
  return node.tagName === 'INPUT' && (node as HTMLInputElement).type === 'range';
}

/**
 * Whether a touch that landed on `el` is allowed to pull the shade down.
 *
 * The same shape as `panBlockFrom`, one axis over: what is refused is the one thing a
 * downward drag would otherwise have been — a scroll — and nothing else. The top band of
 * the screen *is* a card's title bar most of the time, and a shade that could not be
 * pulled from there would be a shade with nowhere to pull it from.
 *
 * And only while there is still a scroll to be had. A list already at its top — a home
 * screen with more icons than fit, scrolled back up — has nothing left to give a
 * downward drag, so the drag is the shade's: the same bargain every phone makes with
 * pull-to-refresh, and without it a screenful of icons is a screen with no shade.
 */
function canPullFrom(el: EventTarget | null): boolean {
  for (let node = el instanceof Element ? el : null; node; node = node.parentElement) {
    if (node.hasAttribute('data-no-pan')) return false;
    // `scrollTop` first: it is a read, where `getComputedStyle` is a style resolution,
    // and at the top of the scroll the answer is the same either way.
    if (node.scrollTop > 0 && node.scrollHeight > node.clientHeight + 1) {
      const overflow = getComputedStyle(node).overflowY;
      if (overflow === 'auto' || overflow === 'scroll') return false;
    }
  }
  return true;
}

/** Whether a touch landed on the open shade or the backdrop around it. */
function isOnShade(el: EventTarget | null): boolean {
  return el instanceof Element && el.closest('[data-shade-surface]') !== null;
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
