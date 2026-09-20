/**
 * The phone gesture layer, driven by touches rather than by its own recogniser.
 *
 * `gestures.test.ts` covers the arithmetic; what is left to get wrong is the wiring —
 * where a pan is allowed to start, whether the desktop actually follows the finger,
 * whether a drag that was not a swipe still gives the tap back, and whether the layer
 * stays out of a desktop's way entirely.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { render, cleanup, act } from '@testing-library/react';
import { useDesktopStore } from '@/store';
import { PhoneGestures } from '@/components/desktop/PhoneGestures';
import { EDGE_GUTTER_PX, PEEK_SETTLE_MS } from '@/lib/gestures';
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

/** Wait out the settle transition, after which the pan has landed and cleaned up. */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, PEEK_SETTLE_MS + 40));
  });
}

/** Real elapsed time between touchstart and touchend — a flick is a speed, not a shape. */
async function slowly() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 80));
  });
}

const monitors = [
  { id: 'a', label: 'Monitor 1', createdAt: 0 },
  { id: 'b', label: 'Monitor 2', createdAt: 0 },
];

const gutters = () => document.querySelectorAll<HTMLElement>('[data-phone-gutter]');
const peekOffsetPx = () =>
  document.documentElement.style.getPropertyValue('--monitor-peek-x').trim();
const panState = () => document.documentElement.getAttribute('data-monitor-peek');
const pullState = () => document.documentElement.getAttribute('data-shade-pull');
const pullPx = () => document.documentElement.style.getPropertyValue('--shade-pull').trim();

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
    });
  });

  afterEach(() => {
    cleanup();
    document.documentElement.removeAttribute('data-monitor-peek');
    document.documentElement.style.removeProperty('--monitor-peek-x');
    document.documentElement.removeAttribute('data-shade-pull');
    document.documentElement.style.removeProperty('--shade-pull');
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

  it('pans from anywhere on the shell, not just the edges', async () => {
    const { container } = render(<PhoneGestures />);
    touch(document.body, 'touchstart', 400, 300);
    touch(document.body, 'touchmove', 320, 305);

    // The monitor being uncovered is on screen and the desktop has moved with the finger.
    expect(container.textContent).toContain('Monitor 2');
    expect(panState()).toBe('dragging');
    expect(peekOffsetPx()).toBe('-80px');

    touch(document.body, 'touchend', 240, 305);
    await settle();
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

  it('falls back to the monitor it started on when the drag was too small', async () => {
    render(<PhoneGestures />);
    touch(document.body, 'touchstart', 400, 300);
    touch(document.body, 'touchmove', 380, 300);
    await slowly();
    touch(document.body, 'touchend', 380, 300);
    await settle();
    expect(useDesktopStore.getState().activeMonitorId).toBe('a');
    expect(panState()).toBeNull();
  });

  it('lands a short flick that was fast enough', async () => {
    render(<PhoneGestures />);
    touch(document.body, 'touchstart', 400, 300);
    touch(document.body, 'touchmove', 370, 300);
    touch(document.body, 'touchend', 370, 300);
    await settle();
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

  it('will not drag the desktop out from under a window', () => {
    const card = document.createElement('div');
    card.setAttribute(WINDOW_ID_DATA_ATTR, 'w1');
    document.body.appendChild(card);
    render(<PhoneGestures />);
    touch(card, 'touchstart', 400, 300);
    touch(card, 'touchmove', 240, 300);
    expect(panState()).toBeNull();
    expect(useDesktopStore.getState().activeMonitorId).toBe('a');
    card.remove();
  });

  it('pans from a gutter, which is how a touch over a card reaches it at all', async () => {
    useDesktopStore.setState({ activeMonitorId: 'b' });
    render(<PhoneGestures />);
    const left = gutters()[0];
    touch(left, 'touchstart', 4, 300);
    touch(left, 'touchmove', 100, 305);
    expect(panState()).toBe('dragging');
    touch(left, 'touchend', 160, 305);
    await settle();
    // Dragging right brings the monitor on the left into view.
    expect(useDesktopStore.getState().activeMonitorId).toBe('a');
  });

  it('resists rather than moves when there is nowhere to go', () => {
    useDesktopStore.setState({ activeMonitorId: 'b' });
    const { container } = render(<PhoneGestures />);
    const right = gutters()[1];
    touch(right, 'touchstart', 396, 300);
    touch(right, 'touchmove', 316, 300);
    // 80px of finger, a quarter of it on screen, and no monitor named — the edge says
    // "no" rather than saying nothing. The right-hand end is the one that is really an
    // end; off the left of monitor 1 is the CLI.
    expect(peekOffsetPx()).toBe('-20px');
    expect(container.textContent).not.toContain('Monitor');
  });

  it('opens the CLI off the left end of the strip, where a phone has no Shift+Tab', async () => {
    const { container } = render(<PhoneGestures />);
    touch(document.body, 'touchstart', 200, 300);
    touch(document.body, 'touchmove', 280, 305);

    // Named while the finger is still down, like any other surface being uncovered.
    expect(container.textContent).toContain('CLI');
    expect(peekOffsetPx()).toBe('80px');

    touch(document.body, 'touchend', 360, 305);
    await settle();
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

  it('drags back out of the CLI the way it came in', async () => {
    useDesktopStore.setState({ cliMode: true });
    const { container } = render(<PhoneGestures />);
    touch(document.body, 'touchstart', 300, 300);
    touch(document.body, 'touchmove', 220, 305);

    // Nothing is drawn for the way back: the desktop is really behind the CLI panel,
    // so the slide uncovers it rather than a picture of it.
    expect(container.querySelector('[data-side]:not([data-phone-gutter])')).toBeNull();
    expect(peekOffsetPx()).toBe('-80px');

    touch(document.body, 'touchend', 140, 305);
    await settle();
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

  it('pulls the notification shade down from the top edge', () => {
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

  it('takes an abandoned pull back up once the finger lifts', async () => {
    render(<PhoneGestures />);
    touch(document.body, 'touchstart', 200, 10);
    touch(document.body, 'touchmove', 203, 40);
    await slowly();
    touch(document.body, 'touchend', 203, 40);
    // Still on screen while it slides back: unmounting it here would be a sheet that
    // vanished rather than one that was put away.
    expect(pullState()).toBe('settling');
    expect(useDesktopStore.getState().notificationShadeOpen).toBe(true);

    await settle();
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

  it('leaves a pull that did not start at the top edge alone', () => {
    render(<PhoneGestures />);
    touch(document.body, 'touchstart', 200, 400);
    touch(document.body, 'touchend', 205, 520);
    expect(useDesktopStore.getState().notificationShadeOpen).toBe(false);
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
