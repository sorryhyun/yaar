/**
 * The screen a tab reports is the one the answer lands on: the soft keyboard (up whenever
 * a prompt is being typed) must not shrink it, and a phone turned sideways has to say so
 * rather than leave it to the aspect ratio (#121).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { readOrientation, resetSettledViewport, settledViewport } from '@/lib/device';

const g = globalThis as Record<string, unknown>;
const saved = ['innerWidth', 'innerHeight', 'matchMedia', 'document', 'screen', 'orientation'].map(
  (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);

function set(key: string, value: unknown) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

function screenAt(w: number, h: number, opts: { coarse?: boolean; focus?: string } = {}) {
  set('innerWidth', w);
  set('innerHeight', h);
  set('matchMedia', (query: string) => ({ matches: opts.coarse ?? true, media: query }));
  set('document', {
    activeElement: opts.focus ? { tagName: opts.focus, type: 'text' } : { tagName: 'BODY' },
  });
}

describe('settledViewport', () => {
  beforeEach(() => resetSettledViewport());
  afterEach(() => {
    for (const [key, desc] of saved) {
      if (desc) Object.defineProperty(globalThis, key, desc);
      else delete g[key];
    }
  });

  it('keeps the full height while the soft keyboard is up, and follows it back down', () => {
    screenAt(697, 330);
    expect(settledViewport()).toEqual({ w: 697, h: 330 });
    // Typing into the palette: same width, most of the height gone.
    screenAt(697, 132, { focus: 'TEXTAREA' });
    expect(settledViewport()).toEqual({ w: 697, h: 330 });
    // An app's field is focused inside its frame; out here only the frame is.
    screenAt(697, 140, { focus: 'IFRAME' });
    expect(settledViewport()).toEqual({ w: 697, h: 330 });
    screenAt(697, 330);
    expect(settledViewport()).toEqual({ w: 697, h: 330 });
  });

  it('takes a rotation as a new screen', () => {
    screenAt(360, 697);
    settledViewport();
    screenAt(697, 330, { focus: 'TEXTAREA' });
    expect(settledViewport()).toEqual({ w: 697, h: 330 });
  });

  it('takes a shorter screen as real when nothing is being typed, or with a mouse', () => {
    screenAt(412, 900);
    settledViewport();
    screenAt(412, 450);
    expect(settledViewport()).toEqual({ w: 412, h: 450 });

    screenAt(1440, 900, { coarse: false });
    settledViewport();
    screenAt(1440, 500, { coarse: false, focus: 'TEXTAREA' });
    expect(settledViewport()).toEqual({ w: 1440, h: 500 });
  });
});

describe('readOrientation', () => {
  afterEach(() => {
    for (const [key, desc] of saved) {
      if (desc) Object.defineProperty(globalThis, key, desc);
      else delete g[key];
    }
  });

  it('believes screen.orientation over the aspect ratio', () => {
    // A keyboard-shrunk portrait screen is wider than tall; the device is still upright.
    set('innerWidth', 360);
    set('innerHeight', 300);
    set('screen', { orientation: { type: 'portrait-primary' } });
    expect(readOrientation()).toBe('portrait');
    set('screen', { orientation: { type: 'landscape-secondary' } });
    expect(readOrientation()).toBe('landscape');
  });

  it('falls back to the legacy angle, then the aspect', () => {
    set('screen', {});
    set('orientation', -90);
    expect(readOrientation()).toBe('landscape');
    set('orientation', undefined);
    set('innerWidth', 360);
    set('innerHeight', 697);
    expect(readOrientation()).toBe('portrait');
  });
});
