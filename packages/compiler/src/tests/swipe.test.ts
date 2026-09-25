import { afterAll, describe, expect, test } from 'bun:test';

/**
 * `onSwipe` is pinned on the rules that make it usable inside a scroller:
 * mostly horizontal, one finger, and not inside something that pans sideways.
 *
 * Elements are hand-rolled fakes; `getComputedStyle` is the only global read.
 */

const g = globalThis as unknown as Record<string, unknown>;
const prevGetComputedStyle = g.getComputedStyle;
g.getComputedStyle = (el: { overflowX?: string }) => ({ overflowX: el.overflowX ?? 'visible' });
afterAll(() => {
  g.getComputedStyle = prevGetComputedStyle;
});

const { onSwipe } = await import('../shims/yaar/ui.js');

type Listener = (e: unknown) => void;
interface FakeEl {
  listeners: Record<string, Listener>;
  parentElement: FakeEl | null;
  scrollWidth: number;
  clientWidth: number;
  overflowX?: string;
  tag?: string;
  closest(sel: string): FakeEl | null;
  addEventListener(type: string, fn: Listener): void;
  removeEventListener(type: string): void;
}

const fakeEl = (over: Partial<FakeEl> = {}): FakeEl => ({
  listeners: {},
  parentElement: null,
  scrollWidth: 100,
  clientWidth: 100,
  closest(sel) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- walking up from the receiver
    for (let n: FakeEl | null = this; n; n = n.parentElement) {
      if (n.tag && sel.includes(n.tag)) return n;
    }
    return null;
  },
  addEventListener(type, fn) {
    this.listeners[type] = fn;
  },
  removeEventListener(type) {
    delete this.listeners[type];
  },
  ...over,
});

const swipe = (root: FakeEl, target: FakeEl, dx: number, dy: number, fingers = 1) => {
  const start = { clientX: 200, clientY: 200 };
  root.listeners.touchstart?.({ target, touches: Array.from({ length: fingers }, () => start) });
  root.listeners.touchend?.({ changedTouches: [{ clientX: 200 + dx, clientY: 200 + dy }] });
};

describe('onSwipe', () => {
  test('a horizontal drag is a swipe in the finger direction', () => {
    const root = fakeEl();
    const seen: string[] = [];
    onSwipe(root as never, (d) => seen.push(d));
    swipe(root, root, -80, 10);
    swipe(root, root, 80, -10);
    expect(seen).toEqual(['left', 'right']);
  });

  test('short, diagonal and two-finger drags are not', () => {
    const root = fakeEl();
    const seen: string[] = [];
    onSwipe(root as never, (d) => seen.push(d));
    swipe(root, root, -30, 0);
    swipe(root, root, -80, 70);
    swipe(root, root, -80, 0, 2);
    expect(seen).toEqual([]);
  });

  test('minDistance moves the threshold', () => {
    const root = fakeEl();
    const seen: string[] = [];
    onSwipe(root as never, (d) => seen.push(d), { minDistance: 20 });
    swipe(root, root, -30, 0);
    expect(seen).toEqual(['left']);
  });

  test('a drag inside an ignored element or a sideways scroller is not', () => {
    const root = fakeEl();
    const video = fakeEl({ parentElement: root, tag: 'video' });
    const zoomed = fakeEl({ parentElement: root, scrollWidth: 400, overflowX: 'auto' });
    const seen: string[] = [];
    onSwipe(root as never, (d) => seen.push(d), { ignore: 'video, audio' });
    swipe(root, video, -80, 0);
    swipe(root, zoomed, -80, 0);
    expect(seen).toEqual([]);
  });

  test('overflow past the root is not a reason to pan', () => {
    const outer = fakeEl({ scrollWidth: 400, overflowX: 'auto' });
    const root = fakeEl({ parentElement: outer });
    const seen: string[] = [];
    onSwipe(root as never, (d) => seen.push(d));
    swipe(root, root, -80, 0);
    expect(seen).toEqual(['left']);
  });

  test('the cleanup detaches it', () => {
    const root = fakeEl();
    const off = onSwipe(root as never, () => {});
    off();
    expect(Object.keys(root.listeners)).toEqual([]);
  });
});
