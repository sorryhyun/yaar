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
 */
import type { Orientation } from '@yaar/shared';

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
 * The viewport with the soft keyboard down.
 *
 * A keyboard only ever takes height, only on a touch screen, and only while focus is on
 * something that takes typing — so a report that shrank in height alone, under all three,
 * keeps the last full height instead. Anything else (a rotation, a desktop window being
 * resized, a split screen with nothing focused) is a real change and replaces it. The
 * memory is per tab, which is the scope a viewport report has.
 */
export function settledViewport(): { w: number; h: number } {
  const now = { w: globalThis.innerWidth, h: globalThis.innerHeight };
  const keyboardLikely =
    settled !== null &&
    now.w === settled.w &&
    now.h < settled.h &&
    typeof globalThis.matchMedia === 'function' &&
    globalThis.matchMedia('(pointer: coarse)').matches &&
    focusTakesTyping(globalThis.document?.activeElement ?? null);
  if (keyboardLikely && settled) return settled;
  settled = now;
  return now;
}

/** Test hook: forget the remembered full-height viewport. */
export function resetSettledViewport(): void {
  settled = null;
}
