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
 *   scroll in, and hands back the one it cannot. The side gutters stay for the case this
 *   document hears nothing about at all: an app card is an iframe, so a touch inside one
 *   reaches no listener here.
 * - **Pull down from the top** brings down the notification shade — which on a phone is
 *   also where the connection and agent readings live — and it comes down with the
 *   finger rather than after it, for the same reason the pan does: a sheet that appears
 *   only once the finger is up gives the user nothing to aim with and no way to change
 *   their mind. The placing is left to CSS through `lib/shade-pull`, which the shade's
 *   own grip writes to as well, so pulling it open and pushing it shut are one gesture
 *   described in one place.
 *
 * The strip the pan runs along is one wider than the monitor list: the **CLI** sits one
 * step to the left of the first monitor. `Shift+Tab` is the way into it on a desktop and
 * a phone has no Shift+Tab, so without this the tmux-style view was simply unreachable
 * there. It is the left-hand end of the strip rather than a mode toggle because that is
 * what makes it reversible by the same gesture, in the direction the finger already knows.
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
  shouldCommitDrag,
  stepMonitorIndex,
  swipeDirection,
} from '@/lib/gestures';
import { settleShadePull, trackShadePull } from '@/lib/shade-pull';
import { resolveWallpaper } from '@/constants/appearance';
import styles from '@/styles/desktop/PhoneGestures.module.css';

/** The CSS var the desktop and the peek panel both translate by. */
const PEEK_X_VAR = '--monitor-peek-x';
/** Published beside it so the settle transition and the settle timer cannot disagree. */
const PEEK_MS_VAR = '--monitor-peek-ms';

/**
 * Where a pan can land: a monitor, the CLI to the left of the first one, or — from
 * inside the CLI — the desktop it was opened from.
 */
type PanTarget = { kind: 'monitor'; id: string } | { kind: 'cli' } | { kind: 'desktop' };

/** The surface a pan is heading for, and enough of it to put on screen behind the drag. */
interface Peek {
  target: PanTarget;
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
  /** Whether this touch is allowed to pull the shade down — the top band, and nothing
   *  vertically scrollable under the finger. */
  canPull: boolean;
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

    /** The surface `delta` steps away, with a look at what is open on it. */
    const neighbour = (delta: number, side: 'left' | 'right'): Peek | null => {
      const { monitors, activeMonitorId, windows, cliMode } = useDesktopStore.getState();
      // Inside the CLI the strip has one exit, and it is the way back in: rightwards.
      // Nothing is drawn for it — the desktop is genuinely behind the panel, so the
      // slide uncovers the real thing rather than a picture of it.
      if (cliMode) {
        return delta > 0 ? { target: { kind: 'desktop' }, label: '', titles: [], side } : null;
      }
      const at = monitors.findIndex((m) => m.id === activeMonitorId);
      if (at === -1) return null;
      const next = stepMonitorIndex(at, monitors.length, delta);
      if (next === null) {
        // Off the left end of the monitor list is not nothing: it is the CLI.
        return delta < 0 && at === 0
          ? { target: { kind: 'cli' }, label: 'CLI', titles: [], side }
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
      return { target: { kind: 'monitor', id: monitor.id }, label: monitor.label, titles, side };
    };

    /** Land on whatever the pan chose. The one place a swipe changes what is on screen. */
    const commit = (target: PanTarget) => {
      const state = useDesktopStore.getState();
      if (target.kind === 'cli') state.setCliMode(true);
      else if (target.kind === 'desktop') state.setCliMode(false);
      else state.switchMonitor(target.id);
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
        root.style.setProperty(PEEK_MS_VAR, `${PEEK_SETTLE_MS}ms`);
      }
      root.style.setProperty(
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
      root.style.setProperty(
        PEEK_X_VAR,
        landing ? `${landing.side === 'left' ? width : -width}px` : '0px',
      );
      settle.current = setTimeout(() => {
        // Switch and un-translate in the same tick: React commits the new surface before
        // the browser paints, so the desktop is never seen at rest showing the old one.
        if (landing) commit(landing.target);
        clearPeek();
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
        return;
      }
      // A touch landing mid-settle takes the pan over rather than fighting it.
      if (settle.current) clearPeek();
      const zone = edgeZone(touch.clientX, touch.clientY, globalThis.innerWidth);
      const state = useDesktopStore.getState();
      const fromGutter = (e.target as Element | null)?.hasAttribute?.('data-phone-gutter') === true;
      const sheetUp = state.paletteSheetOpen || state.notificationShadeOpen;
      drag.current = {
        x: touch.clientX,
        y: touch.clientY,
        at: performance.now(),
        axis: null,
        // The shade may be pulled from over a card's title bar — that is what the top
        // band is sized for — so this asks a different question from `panBlockFrom`:
        // not "which way may this pan?" but "would the finger have scrolled something?".
        canPull: zone === 'top' && !sheetUp && (fromGutter || canPullFrom(e.target)),
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
        if (d.canPull && dy > 0 && e.cancelable) e.preventDefault();
        d.axis = dragAxis(dx, dy);
        if (!d.axis) return;
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
        return;
      }
      const dx = touch.clientX - d.x;
      const dy = touch.clientY - d.y;

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
      {peek && peek.target.kind !== 'desktop' && (
        <div
          className={styles.peek}
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
