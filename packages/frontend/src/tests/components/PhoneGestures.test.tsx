/**
 * The phone gesture layer, driven by touches rather than by its own recogniser.
 *
 * `gestures.test.ts` covers the arithmetic; what is left to get wrong is the wiring —
 * which element carries which gesture, whether a drag that was not a swipe still gives
 * the tap back, and whether the layer stays out of a desktop's way entirely.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { render, cleanup, act } from '@testing-library/react';
import { useDesktopStore } from '@/store';
import { PhoneGestures } from '@/components/desktop/PhoneGestures';
import { EDGE_GUTTER_PX } from '@/lib/gestures';

/**
 * happy-dom has no TouchEvent constructor, and React only reads `touches` /
 * `changedTouches` off the native event, so a plain Event carrying those two lists is
 * indistinguishable from the real thing as far as the handlers are concerned.
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
  // The swipe preview is local React state, so the dispatch has to be flushed before
  // the assertion can see it.
  act(() => {
    target.dispatchEvent(event);
  });
}

const monitors = [
  { id: 'a', label: 'Monitor 1', createdAt: 0 },
  { id: 'b', label: 'Monitor 2', createdAt: 0 },
];

const gutters = () => document.querySelectorAll<HTMLElement>('[data-side]');

describe('PhoneGestures', () => {
  beforeEach(() => {
    useDesktopStore.setState({
      formFactor: 'mobile',
      monitors,
      activeMonitorId: 'a',
      notificationShadeOpen: false,
      paletteSheetOpen: false,
    });
  });

  afterEach(cleanup);

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

  it('swiping in from the left edge goes to the previous monitor', () => {
    useDesktopStore.setState({ activeMonitorId: 'b' });
    render(<PhoneGestures />);
    const left = gutters()[0];
    touch(left, 'touchstart', 4, 300);
    touch(left, 'touchend', 160, 305);
    expect(useDesktopStore.getState().activeMonitorId).toBe('a');
  });

  it('swiping the other way goes to the next one', () => {
    render(<PhoneGestures />);
    const left = gutters()[0];
    touch(left, 'touchstart', 160, 300);
    touch(left, 'touchend', 4, 305);
    expect(useDesktopStore.getState().activeMonitorId).toBe('b');
  });

  it('names the monitor it is heading for while the finger is still down', () => {
    const { container } = render(<PhoneGestures />);
    const left = gutters()[0];
    touch(left, 'touchstart', 160, 300);
    touch(left, 'touchmove', 104, 300);
    expect(container.textContent).toContain('Monitor 2');
    // The name goes away with the finger, whatever the swipe turned out to be.
    touch(left, 'touchend', 4, 300);
    expect(container.textContent).not.toContain('Monitor 2');
  });

  it('stays put at the end of the list', () => {
    render(<PhoneGestures />);
    const left = gutters()[0];
    touch(left, 'touchstart', 160, 300);
    touch(left, 'touchend', 4, 300);
    expect(useDesktopStore.getState().activeMonitorId).toBe('b');
    touch(left, 'touchstart', 160, 300);
    touch(left, 'touchend', 4, 300);
    expect(useDesktopStore.getState().activeMonitorId).toBe('b');
  });

  it('hands a tap back to whatever the gutter was covering', () => {
    const below = document.createElement('button');
    let tapped = false;
    below.addEventListener('click', () => {
      tapped = true;
    });
    document.body.appendChild(below);
    // The gutter takes itself out of hit-testing to find what is underneath; in
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

  it('sizes the gutters from the constant the recogniser uses', () => {
    render(<PhoneGestures />);
    for (const gutter of gutters()) {
      expect(gutter.style.width).toBe(`${EDGE_GUTTER_PX}px`);
    }
  });
});
