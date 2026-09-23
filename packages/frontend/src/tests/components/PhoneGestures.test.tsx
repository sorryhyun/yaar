/**
 * The phone gesture layer, driven by touches rather than by its own recogniser.
 *
 * `gestures.test.ts` covers the arithmetic; what is left to get wrong is the wiring —
 * where a pan is allowed to start, whether the desktop actually follows the finger,
 * whether a drag that was not a swipe still gives the tap back, and whether the layer
 * stays out of a desktop's way entirely.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
import { render, cleanup, act } from '@testing-library/react';
import { useDesktopStore } from '@/store';
import { PhoneGestures } from '@/components/desktop/PhoneGestures';
import { MAX_MONITORS, APP_MSG } from '@yaar/shared';
import {
  EDGE_GUTTER_PX,
  PEEK_SETTLE_MS,
  SHADE_CLEAR_HOLD_MS,
  SHADE_CLEAR_PX,
} from '@/lib/gestures';
import { clearGestureVars, getGestureVar } from '@/lib/gesture-layer';
import { WINDOW_ID_DATA_ATTR } from '@/constants/layout';

/**
 * happy-dom has no TouchEvent constructor, and the handlers only read `touches` /
 * `changedTouches` off the event, so a plain Event carrying those two lists is
 * indistinguishable from the real thing as far as they are concerned.
 *
 * The constructor has to be the document's own: `dispatchEvent` type-checks its
 * argument against the window it belongs to, and the global `Event` in this runtime is
 * Bun's, not happy-dom's.
 */
function touch(target: EventTarget, type: string, x: number, y: number) {
  const DomEvent = document.defaultView!.Event;
  const event = new DomEvent(type, { bubbles: true, cancelable: true });
  const list = [{ clientX: x, clientY: y, identifier: 0 }];
  Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : list });
  Object.defineProperty(event, 'changedTouches', { value: list });
  // The peek panel is local React state, so the dispatch has to be flushed before the
  // assertion can see it.
  act(() => {
    target.dispatchEvent(event);
  });
}

/**
 * Fast-forward the settle transition, after which the pan has landed and cleaned up.
 * The handlers schedule a real `setTimeout`; the fake clock installed in `beforeEach`
 * makes advancing it instant instead of a real wait on `PEEK_SETTLE_MS`.
 */
function settle() {
  act(() => {
    jest.advanceTimersByTime(PEEK_SETTLE_MS + 40);
  });
}

/**
 * Elapsed time between touchstart and touchend, as the handlers read it off
 * `performance.now()` — a flick is a speed, not a shape. Driven off the same fake
 * clock as `settle()`, so it is deterministic instead of "however fast this run's
 * synchronous JS between the two touch calls happened to execute."
 */
function slowly() {
  act(() => {
    jest.advanceTimersByTime(80);
  });
}

/**
 * A sliver of elapsed time between touchstart and touchend, standing in for "fast
 * enough to be a flick." Under the fake clock two touches back to back are exactly
 * `elapsedMs === 0` — real `performance.now()` never landed on the exact same tick,
 * but the fake one does, and `shouldCommitDrag` requires `elapsedMs > 0` — so a flick
 * test needs this the same way a nudge test needs `slowly()`, just on the other side
 * of the velocity threshold.
 */
function quickly() {
  act(() => {
    jest.advanceTimersByTime(1);
  });
}

const monitors = [
  { id: 'a', label: 'Monitor 1', createdAt: 0 },
  { id: 'b', label: 'Monitor 2', createdAt: 0 },
];

/**
 * A sideways scroller inside a window card. happy-dom lays nothing out, so the three
 * numbers the recogniser reads are set directly — which is the whole of what it asks.
 */
function sidewaysScroller(metrics: {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
}) {
  const card = document.createElement('div');
  card.setAttribute(WINDOW_ID_DATA_ATTR, 'w1');
  const strip = document.createElement('div');
  strip.style.overflowX = 'auto';
  for (const [key, value] of Object.entries(metrics)) {
    Object.defineProperty(strip, key, { value, configurable: true });
  }
  card.appendChild(strip);
  document.body.appendChild(card);
  return strip;
}

const gutters = () => document.querySelectorAll<HTMLElement>('[data-phone-gutter]');
const peekOffsetPx = () => getGestureVar('monitor-peek', '--monitor-peek-x');
const panState = () => document.documentElement.getAttribute('data-monitor-peek');
const pullState = () => document.documentElement.getAttribute('data-shade-pull');
const pullPx = () => getGestureVar('shade-pull', '--shade-pull');

const originalCreateMonitor = useDesktopStore.getState().createMonitor;

describe('PhoneGestures', () => {
  beforeEach(() => {
    useDesktopStore.setState({
      formFactor: 'mobile',
      monitors,
      activeMonitorId: 'a',
      windows: {},
      cliMode: false,
      notificationShadeOpen: false,
      paletteSheetOpen: false,
      toasts: {},
      createMonitor: originalCreateMonitor,
    });
    // Fake from before any touch in the test, not just around `settle()`/`slowly()`: the
    // handlers time a drag off `performance.now()`, which the fake clock also controls
    // (confirmed empirically — advancing it moves `performance.now()` the same as
    // `Date.now()`), so a touch sequence and its wait have to share one clock or the
    // elapsed-time arithmetic the handlers do is measuring two different clocks.
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    cleanup();
    document.documentElement.removeAttribute('data-monitor-peek');
    clearGestureVars('monitor-peek');
    document.documentElement.removeAttribute('data-shade-pull');
    document.documentElement.removeAttribute('data-shade-clear');
    clearGestureVars('shade-pull');
  });

  it('renders nothing at all on a desktop', () => {
    useDesktopStore.setState({ formFactor: 'desktop' });
    const { container } = render(<PhoneGestures />);
    expect(container.innerHTML).toBe('');
  });

  it('keeps its gutters even with one monitor, because the CLI is still over there', () => {
    useDesktopStore.setState({ monitors: [monitors[0]] });
    render(<PhoneGestures />);
    expect(gutters()).toHaveLength(2);
  });

  it('pans from anywhere on the shell, not just the edges', () => {
    const { container } = render(<PhoneGestures />);
    touch(document.body, 'touchstart', 400, 300);
    touch(document.body, 'touchmove', 320, 305);

    // The monitor being uncovered is on screen and the desktop has moved with the finger.
    expect(container.textContent).toContain('Monitor 2');
    expect(panState()).toBe('dragging');
    expect(peekOffsetPx()).toBe('-80px');

    touch(document.body, 'touchend', 240, 305);
    settle();
    expect(useDesktopStore.getState().activeMonitorId).toBe('b');
    // Nothing of the pan is left behind — a stale transform would hold the desktop off
    // screen for the rest of the session.
    expect(panState()).toBeNull();
    expect(container.textContent).not.toContain('Monitor 2');
  });

  it('names what is open on the monitor it is heading for', () => {
    useDesktopStore.setState({
      windows: {
        w1: {
          id: 'w1',
          title: 'Notes',
          bounds: { x: 0, y: 0, w: 10, h: 10 },
          content: { renderer: 'text', data: '' },
          minimized: false,
          maximized: false,
          monitorId: 'b',
        },
      } as never,
    });
    const { container } = render(<PhoneGestures />);
    touch(document.body, 'touchstart', 400, 300);
    touch(document.body, 'touchmove', 320, 300);
    expect(container.textContent).toContain('Notes');
  });

  it('falls back to the monitor it started on when the drag was too small', () => {
    render(<PhoneGestures />);
    touch(document.body, 'touchstart', 400, 300);
    touch(document.body, 'touchmove', 380, 300);
    slowly();
    touch(document.body, 'touchend', 380, 300);
    settle();
    expect(useDesktopStore.getState().activeMonitorId).toBe('a');
    expect(panState()).toBeNull();
  });

  it('lands a short flick that was fast enough', () => {
    render(<PhoneGestures />);
    touch(document.body, 'touchstart', 400, 300);
    touch(document.body, 'touchmove', 370, 300);
    quickly();
    touch(document.body, 'touchend', 370, 300);
    settle();
    expect(useDesktopStore.getState().activeMonitorId).toBe('b');
  });

  it('leaves a vertical drag to the page', () => {
    render(<PhoneGestures />);
    touch(document.body, 'touchstart', 400, 300);
    touch(document.body, 'touchmove', 404, 240);
    // The axis is locked on the first frame that decided it, so the arc back sideways
    // does not take the drag over halfway through.
    touch(document.body, 'touchmove', 300, 240);
    expect(panState()).toBeNull();
  });

  it('pans from over a window, which on a phone is most of the screen', () => {
    const card = document.createElement('div');
    card.setAttribute(WINDOW_ID_DATA_ATTR, 'w1');
    document.body.appendChild(card);
    render(<PhoneGestures />);
    touch(card, 'touchstart', 400, 300);
    touch(card, 'touchmove', 240, 300);
    expect(panState()).toBe('dragging');
    touch(card, 'touchend', 240, 300);
    settle();
    expect(useDesktopStore.getState().activeMonitorId).toBe('b');
    card.remove();
  });

  it('leaves the drag to a sideways scroller that can still scroll that way', () => {
    const strip = sidewaysScroller({ scrollLeft: 0, scrollWidth: 300, clientWidth: 100 });
    render(<PhoneGestures />);
    touch(strip, 'touchstart', 400, 300);
    touch(strip, 'touchmove', 240, 300);
    expect(panState()).toBeNull();
    expect(useDesktopStore.getState().activeMonitorId).toBe('a');
    strip.parentElement!.remove();
  });

  it('takes the drag the scroller has no use for, which is the one off its end', () => {
    const strip = sidewaysScroller({ scrollLeft: 0, scrollWidth: 300, clientWidth: 100 });
    render(<PhoneGestures />);
    // Dragging right would scroll the strip back past its start — it is at the start,
    // so the drag is the shell's and the monitor on the left comes in.
    touch(strip, 'touchstart', 200, 300);
    touch(strip, 'touchmove', 280, 300);
    expect(panState()).toBe('dragging');
    strip.parentElement!.remove();
  });

  it('pans from a gutter, which is how a touch over a card reaches it at all', () => {
    useDesktopStore.setState({ activeMonitorId: 'b' });
    render(<PhoneGestures />);
    const left = gutters()[0];
    touch(left, 'touchstart', 4, 300);
    touch(left, 'touchmove', 100, 305);
    expect(panState()).toBe('dragging');
    touch(left, 'touchend', 160, 305);
    settle();
    // Dragging right brings the monitor on the left into view.
    expect(useDesktopStore.getState().activeMonitorId).toBe('a');
  });

  it('resists rather than moves when there is nowhere to go', () => {
    // Off the right of the last monitor is a new one — until the session is full, which
    // is the one place the strip really ends. Off the left of monitor 1 is the CLI.
    const full = Array.from({ length: MAX_MONITORS }, (_, i) => ({
      id: String(i),
      label: `Monitor ${i + 1}`,
      createdAt: 0,
    }));
    useDesktopStore.setState({ monitors: full, activeMonitorId: String(MAX_MONITORS - 1) });
    const { container } = render(<PhoneGestures />);
    const right = gutters()[1];
    touch(right, 'touchstart', 396, 300);
    touch(right, 'touchmove', 316, 300);
    // 80px of finger, a quarter of it on screen, and nothing named — the edge says "no"
    // rather than saying nothing.
    expect(peekOffsetPx()).toBe('-20px');
    expect(container.textContent).toBe('');
  });

  it('offers a new monitor off the right end of the strip, numbered as it will be', () => {
    useDesktopStore.setState({ activeMonitorId: 'b' });
    const createMonitor = jest.fn();
    useDesktopStore.setState({ createMonitor });
    const { container } = render(<PhoneGestures />);
    touch(document.body, 'touchstart', 300, 300);
    touch(document.body, 'touchmove', 220, 305);

    // Two monitors, ids 'a' and 'b': the server's lowest free integer id is 0.
    expect(peekOffsetPx()).toBe('-80px');
    expect(container.textContent).toContain('New monitor');
    expect(container.querySelector('[data-new]')?.textContent).toContain('1');

    touch(document.body, 'touchend', 140, 305);
    settle();
    expect(createMonitor).toHaveBeenCalledTimes(1);
    // Held where it landed until the server's answer switches this tab over, so the
    // desktop that was just left is not what fills the wait.
    expect(panState()).toBe('settling');

    act(() => {
      useDesktopStore.setState({ activeMonitorId: 'c' });
    });
    expect(panState()).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('gives the old desktop back if the new monitor never arrives', () => {
    useDesktopStore.setState({ activeMonitorId: 'b', createMonitor: () => {} });
    render(<PhoneGestures />);
    touch(document.body, 'touchstart', 300, 300);
    touch(document.body, 'touchmove', 220, 305);
    touch(document.body, 'touchend', 140, 305);
    settle();
    expect(panState()).toBe('settling');
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(panState()).toBeNull();
    expect(useDesktopStore.getState().activeMonitorId).toBe('b');
  });

  it('shows the number of the monitor it is heading for, large, while the finger is down', () => {
    const { container } = render(<PhoneGestures />);
    touch(document.body, 'touchstart', 300, 300);
    touch(document.body, 'touchmove', 220, 305);
    const badge = container.querySelector('[data-peek-badge]');
    expect(badge?.textContent).toBe('2');

    touch(document.body, 'touchend', 140, 305);
    settle();
    expect(container.querySelector('[data-peek-badge]')).toBeNull();
  });

  it('opens the CLI off the left end of the strip, where a phone has no Shift+Tab', () => {
    const { container } = render(<PhoneGestures />);
    touch(document.body, 'touchstart', 200, 300);
    touch(document.body, 'touchmove', 280, 305);

    // Named while the finger is still down, like any other surface being uncovered.
    expect(container.textContent).toContain('CLI');
    expect(peekOffsetPx()).toBe('80px');

    touch(document.body, 'touchend', 360, 305);
    settle();
    expect(useDesktopStore.getState().cliMode).toBe(true);
    expect(panState()).toBeNull();
  });

  it('leaves the CLI where it is when the drag comes from a later monitor', () => {
    useDesktopStore.setState({ activeMonitorId: 'b' });
    const { container } = render(<PhoneGestures />);
    touch(document.body, 'touchstart', 200, 300);
    touch(document.body, 'touchmove', 280, 305);
    // Monitor 1 is what is on the left of monitor 2 — the CLI is only off the far end.
    expect(container.textContent).toContain('Monitor 1');
    expect(container.textContent).not.toContain('CLI');
  });

  it('drags back out of the CLI the way it came in', () => {
    useDesktopStore.setState({ cliMode: true });
    const { container } = render(<PhoneGestures />);
    touch(document.body, 'touchstart', 300, 300);
    touch(document.body, 'touchmove', 220, 305);

    // Nothing is drawn for the way back: the desktop is really behind the CLI panel,
    // so the slide uncovers it rather than a picture of it.
    expect(container.querySelector('[data-side]:not([data-phone-gutter])')).toBeNull();
    expect(peekOffsetPx()).toBe('-80px');

    touch(document.body, 'touchend', 140, 305);
    settle();
    expect(useDesktopStore.getState().cliMode).toBe(false);
  });

  it('will not drag further left out of the CLI — it is the end of the strip', () => {
    useDesktopStore.setState({ cliMode: true });
    render(<PhoneGestures />);
    touch(document.body, 'touchstart', 200, 300);
    touch(document.body, 'touchmove', 280, 300);
    // 80px of finger, a quarter of it on screen: resistance, not a move.
    expect(peekOffsetPx()).toBe('20px');
    touch(document.body, 'touchend', 360, 300);
    expect(useDesktopStore.getState().cliMode).toBe(true);
  });

  it('switches on a flick the browser coalesced into a start and an end', () => {
    render(<PhoneGestures />);
    touch(document.body, 'touchstart', 400, 300);
    touch(document.body, 'touchend', 240, 305);
    expect(useDesktopStore.getState().activeMonitorId).toBe('b');
  });

  it('hands a tap back to whatever the gutter was covering', () => {
    const below = document.createElement('button');
    let tapped = false;
    below.addEventListener('click', () => {
      tapped = true;
    });
    document.body.appendChild(below);
    // The gutters take themselves out of hit-testing to find what is underneath; in
    // happy-dom every point answers with the deepest element, which is this button.
    document.elementFromPoint = () => below;

    render(<PhoneGestures />);
    const left = gutters()[0];
    touch(left, 'touchstart', 4, 300);
    touch(left, 'touchend', 6, 302);

    expect(tapped).toBe(true);
    expect(useDesktopStore.getState().activeMonitorId).toBe('a');
    below.remove();
  });

  it('pulls the notification shade down', () => {
    render(<PhoneGestures />);
    touch(document.body, 'touchstart', 200, 10);
    touch(document.body, 'touchend', 205, 120);
    expect(useDesktopStore.getState().notificationShadeOpen).toBe(true);
  });

  it('brings the shade down with the finger rather than after it', () => {
    render(<PhoneGestures />);
    touch(document.body, 'touchstart', 200, 10);
    touch(document.body, 'touchmove', 203, 50);

    // On screen from the first frame of the drag, and 40px of it — as far as the finger
    // has come, not as far as the gesture will eventually have gone.
    expect(useDesktopStore.getState().notificationShadeOpen).toBe(true);
    expect(pullState()).toBe('dragging');
    expect(pullPx()).toBe('40px');
  });

  it('follows a pull that changes its mind back up again', () => {
    render(<PhoneGestures />);
    touch(document.body, 'touchstart', 200, 10);
    touch(document.body, 'touchmove', 203, 50);
    touch(document.body, 'touchmove', 203, 20);
    expect(pullPx()).toBe('10px');
  });

  it('takes an abandoned pull back up once the finger lifts', () => {
    render(<PhoneGestures />);
    touch(document.body, 'touchstart', 200, 10);
    touch(document.body, 'touchmove', 203, 40);
    slowly();
    touch(document.body, 'touchend', 203, 40);
    // Still on screen while it slides back: unmounting it here would be a sheet that
    // vanished rather than one that was put away.
    expect(pullState()).toBe('settling');
    expect(useDesktopStore.getState().notificationShadeOpen).toBe(true);

    settle();
    expect(useDesktopStore.getState().notificationShadeOpen).toBe(false);
  });

  /** A scroller of `scrollTop`, as the home screen's icon grid is one. */
  function scroller(scrollTop: number) {
    const list = document.createElement('div');
    list.style.overflowY = 'scroll';
    Object.defineProperty(list, 'scrollHeight', { value: 400 });
    Object.defineProperty(list, 'clientHeight', { value: 100 });
    Object.defineProperty(list, 'scrollTop', { value: scrollTop, writable: true });
    document.body.appendChild(list);
    return list;
  }

  it('leaves a vertical drag over something scrollable to the scroll', () => {
    const list = scroller(50);
    render(<PhoneGestures />);

    touch(list, 'touchstart', 200, 10);
    touch(list, 'touchmove', 203, 60);
    expect(pullState()).toBeNull();
    expect(useDesktopStore.getState().notificationShadeOpen).toBe(false);
    list.remove();
  });

  it('takes the drag back once that scroller has nothing left to scroll', () => {
    // A home screen with more icons than fit would otherwise be a screen with no shade
    // on it at all: the grid is under the whole top band, scrolled to the top or not.
    const list = scroller(0);
    render(<PhoneGestures />);

    touch(list, 'touchstart', 200, 10);
    touch(list, 'touchmove', 203, 60);
    expect(pullState()).toBe('dragging');
    expect(useDesktopStore.getState().notificationShadeOpen).toBe(true);
    list.remove();
  });

  it('pulls the shade from anywhere, not just the top edge, as the pan pans from anywhere', () => {
    render(<PhoneGestures />);
    touch(document.body, 'touchstart', 200, 400);
    touch(document.body, 'touchmove', 203, 450);
    expect(pullState()).toBe('dragging');
    expect(pullPx()).toBe('50px');
  });

  /** The open shade's sheet, as `NotificationShade` marks it. */
  function openShade() {
    useDesktopStore.setState({ notificationShadeOpen: true });
    const sheet = document.createElement('div');
    sheet.setAttribute('data-shade-surface', '');
    document.body.appendChild(sheet);
    return sheet;
  }

  const clearState = () => document.documentElement.getAttribute('data-shade-clear');
  const toasts = () => Object.values(useDesktopStore.getState().toasts);

  it('clears the context when an open shade is pulled down again, far enough', () => {
    const sheet = openShade();
    render(<PhoneGestures />);
    touch(sheet, 'touchstart', 200, 300);
    touch(sheet, 'touchmove', 203, 360);
    // Stretched, not yet armed: letting go here would do nothing.
    expect(clearState()).toBe('dragging');
    expect(getGestureVar('shade-pull', '--shade-overpull')).toBe('30px');

    touch(sheet, 'touchmove', 203, 300 + SHADE_CLEAR_PX + 10);
    expect(clearState()).toBe('armed');
    touch(sheet, 'touchend', 203, 300 + SHADE_CLEAR_PX + 10);

    expect(toasts().some((t) => t.id.startsWith('reset-'))).toBe(true);
    // Held stretched on "cleared" for a beat, so the gesture itself says it worked.
    expect(clearState()).toBe('cleared');
    act(() => {
      jest.advanceTimersByTime(SHADE_CLEAR_HOLD_MS - 10);
    });
    expect(clearState()).toBe('cleared');
    expect(useDesktopStore.getState().notificationShadeOpen).toBe(true);
    act(() => {
      jest.advanceTimersByTime(10);
    });
    expect(clearState()).toBe('settling');
    settle();
    // Done with: the pull was for the reset, and the shade has nothing left to be open for.
    expect(clearState()).toBeNull();
    expect(useDesktopStore.getState().notificationShadeOpen).toBe(false);
    sheet.remove();
  });

  it('springs back and clears nothing when the second pull is let go short', () => {
    const sheet = openShade();
    render(<PhoneGestures />);
    touch(sheet, 'touchstart', 200, 300);
    touch(sheet, 'touchmove', 203, 300 + SHADE_CLEAR_PX + 10);
    // Seen the hint turn, thought better of it, slid back up before lifting.
    touch(sheet, 'touchmove', 203, 340);
    touch(sheet, 'touchend', 203, 340);
    settle();

    expect(toasts()).toHaveLength(0);
    expect(clearState()).toBeNull();
    expect(useDesktopStore.getState().notificationShadeOpen).toBe(true);
    sheet.remove();
  });

  it('does not clear a pull that has started back up, even while still past the line', () => {
    const sheet = openShade();
    render(<PhoneGestures />);
    touch(sheet, 'touchstart', 200, 300);
    touch(sheet, 'touchmove', 203, 300 + SHADE_CLEAR_PX + 60);
    expect(clearState()).toBe('armed');
    // Coming back up: still well past the line, but no longer pulling down — disarmed,
    // and the hint says so before the finger lifts.
    touch(sheet, 'touchmove', 203, 300 + SHADE_CLEAR_PX + 20);
    expect(clearState()).toBe('dragging');
    touch(sheet, 'touchend', 203, 300 + SHADE_CLEAR_PX + 20);
    settle();

    expect(toasts()).toHaveLength(0);
    expect(useDesktopStore.getState().notificationShadeOpen).toBe(true);
    sheet.remove();
  });

  it('still clears when a finger held at the bottom wobbles a few pixels', () => {
    const sheet = openShade();
    render(<PhoneGestures />);
    touch(sheet, 'touchstart', 200, 300);
    touch(sheet, 'touchmove', 203, 300 + SHADE_CLEAR_PX + 40);
    touch(sheet, 'touchmove', 203, 300 + SHADE_CLEAR_PX + 34);
    expect(clearState()).toBe('armed');
    touch(sheet, 'touchend', 203, 300 + SHADE_CLEAR_PX + 34);
    expect(toasts().some((t) => t.id.startsWith('reset-'))).toBe(true);
    sheet.remove();
  });

  it('pulls the shade from over an app card, through the frame script', () => {
    // The shape the router resolves a message's source from: a window holding an iframe.
    // A synthetic event, because happy-dom's postMessage loses `source` identity.
    const card = document.createElement('div');
    card.setAttribute(WINDOW_ID_DATA_ATTR, 'w1');
    const iframe = document.createElement('iframe');
    card.appendChild(iframe);
    document.body.appendChild(card);
    render(<PhoneGestures />);
    const frame = (phase: string, dy: number) =>
      act(() => {
        const ev = new document.defaultView!.Event('message');
        Object.defineProperty(ev, 'data', {
          value: { type: APP_MSG.touchPan, phase, dx: 0, dy, axis: 'y' },
        });
        Object.defineProperty(ev, 'source', { value: iframe.contentWindow });
        window.dispatchEvent(ev);
      });
    frame('start', 12);
    frame('move', 70);
    expect(pullState()).toBe('dragging');
    expect(pullPx()).toBe('70px');
    // Not a monitor pan: the axis says so.
    expect(panState()).toBeNull();
    card.remove();
  });

  it('does not pull the shade over a palette that is already up', () => {
    useDesktopStore.setState({ paletteSheetOpen: true });
    render(<PhoneGestures />);
    touch(document.body, 'touchstart', 200, 10);
    touch(document.body, 'touchend', 205, 120);
    expect(useDesktopStore.getState().notificationShadeOpen).toBe(false);
  });

  it('does not pan while a sheet is up either', () => {
    useDesktopStore.setState({ paletteSheetOpen: true });
    render(<PhoneGestures />);
    touch(document.body, 'touchstart', 400, 300);
    touch(document.body, 'touchmove', 240, 300);
    expect(panState()).toBeNull();
  });

  it('sizes the gutters from the constant the recogniser uses', () => {
    render(<PhoneGestures />);
    for (const gutter of gutters()) {
      expect(gutter.style.width).toBe(`${EDGE_GUTTER_PX}px`);
    }
  });
});
