/**
 * What this tab tells the server (and its apps) about the screen, beyond the form factor:
 * how the device is held, and how big the screen is with the soft keyboard down.
 *
 * Both exist because the raw window size answers neither. On a phone `innerHeight` is
 * the height *above the keyboard* (the shell asks for `interactive-widget=resizes-content`),
 * and the keyboard is up exactly when the user is typing a prompt — so the size the
 * monitor agent was given for its turn was the keyboard-shrunk one (697×330 landscape
 * reported as 697×132), and a short, wide rectangle said nothing about which way the
 * phone was turned.
 *
 * The keyboard itself is reported only where it is the answer: next to a screenshot,
 * which is taken at whatever height the keyboard left.
 */
import type { Orientation, SoftKeyboard } from '@yaar/shared';

export type { Orientation };

/**
 * How the device is held. `screen.orientation` is the device's own answer; the legacy
 * `window.orientation` angle covers iOS Safari before 16.4, and the viewport's aspect is
 * the last resort for a browser with neither.
 */
export function readOrientation(): Orientation {
  const type = globalThis.screen?.orientation?.type;
  if (type) return type.startsWith('landscape') ? 'landscape' : 'portrait';
  const angle = (globalThis as { orientation?: unknown }).orientation;
  if (typeof angle === 'number') return Math.abs(angle) === 90 ? 'landscape' : 'portrait';
  return globalThis.innerWidth > globalThis.innerHeight ? 'landscape' : 'portrait';
}

/**
 * Whether focus is somewhere a soft keyboard would open for. An iframe counts: an app's
 * text field is focused *inside* its frame, and from out here that is only ever visible
 * as the frame itself being the active element.
 */
function focusTakesTyping(el: Element | null): boolean {
  if (!el) return false;
  if (el.tagName === 'IFRAME' || el.tagName === 'TEXTAREA') return true;
  if (el.tagName === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return !['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset'].includes(
      type,
    );
  }
  return (el as HTMLElement).isContentEditable === true;
}

let settled: { w: number; h: number } | null = null;

/**
 * The height actually left to look at. iOS Safari leaves `innerHeight` alone under a
 * keyboard and shrinks only the visual viewport, so that is the one to ask where it
 * exists — scaled back by the pinch zoom, which shrinks it too while taking no screen.
 */
function visibleHeight(layoutHeight: number): number {
  const vv = globalThis.visualViewport;
  if (!vv) return layoutHeight;
  return Math.min(layoutHeight, Math.round(vv.height * (vv.scale || 1)));
}

/**
 * The screen with the soft keyboard down, and — while it is up — the keyboard.
 *
 * A keyboard only ever takes height, only on a touch screen, and only while focus is on
 * something that takes typing — so a reading that shrank in height alone, under all three,
 * keeps the last full height instead. Anything else (a rotation, a desktop window being
 * resized, a split screen with nothing focused) is a real change and replaces it. The
 * memory is per tab, which is the scope a viewport report has.
 */
function readScreen(): { viewport: { w: number; h: number }; keyboard?: SoftKeyboard } {
  const now = { w: globalThis.innerWidth, h: globalThis.innerHeight };
  const visible = { w: now.w, h: visibleHeight(now.h) };
  const keyboardLikely =
    settled !== null &&
    now.w === settled.w &&
    visible.h < settled.h &&
    typeof globalThis.matchMedia === 'function' &&
    globalThis.matchMedia('(pointer: coarse)').matches &&
    focusTakesTyping(globalThis.document?.activeElement ?? null);
  if (keyboardLikely && settled) return { viewport: settled, keyboard: { visible, full: settled } };
  settled = now;
  return { viewport: now };
}

/**
 * The viewport with the soft keyboard down — what the server sizes windows for, since
 * the keyboard is up exactly while a prompt is being typed. See `readScreen`.
 */
export function settledViewport(): { w: number; h: number } {
  return readScreen().viewport;
}

/**
 * The soft keyboard, if it is up right now: the size left visible above it and the size
 * without it. The same judgement `settledViewport` makes to *hide* the keyboard, turned
 * around to report it — a screenshot of a card squished by the keyboard has to say so,
 * or it reads as a broken layout (#125).
 */
export function softKeyboard(): SoftKeyboard | undefined {
  return readScreen().keyboard;
}

/** Test hook: forget the remembered full-height viewport. */
export function resetSettledViewport(): void {
  settled = null;
}
