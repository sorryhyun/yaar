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
  });

  it('renders nothing at all on a desktop', () => {
    useDesktopStore.setState({ formFactor: 'desktop' });
    const { container } = render(<PhoneGestures />);
    expect(container.innerHTML).toBe('');
  });

  it('puts no gutters over the screen when there is only one monitor', () => {
    useDesktopStore.setState({ monitors: [monitors[0]] });
    render(<PhoneGestures />);
    expect(gutters()).toHaveLength(0);
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
    render(<PhoneGestures />);
    const left = gutters()[0];
    touch(left, 'touchstart', 4, 300);
    touch(left, 'touchmove', 100, 305);
    expect(panState()).toBe('dragging');
    touch(left, 'touchend', 160, 305);
    await settle();
    // Dragging right brings the monitor on the left into view, and there is none.
    expect(useDesktopStore.getState().activeMonitorId).toBe('a');
  });

  it('resists rather than moves when there is nowhere to go', () => {
    const { container } = render(<PhoneGestures />);
    const left = gutters()[0];
    touch(left, 'touchstart', 4, 300);
    touch(left, 'touchmove', 84, 300);
    // 80px of finger, a quarter of it on screen, and no monitor named — the edge says
    // "no" rather than saying nothing.
    expect(peekOffsetPx()).toBe('20px');
    expect(container.textContent).not.toContain('Monitor');
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
