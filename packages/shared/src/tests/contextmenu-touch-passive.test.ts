/**
 * The in-app touch relay never makes a scroll wait for the app's main thread.
 *
 * A non-passive touchmove listener on `window` makes the browser hold every touch scroll
 * in the frame until that frame's main thread has run it. Every isolated app shares one
 * origin, so every app iframe in a tab shares one main thread. With the relay's listener
 * non-passive, one app busy for ten seconds froze touch scrolling in all of them for ten
 * seconds, and tapping did not help. Measured over CDP: a sibling frame busy-looping froze
 * the scroll with the non-passive listener, and did not with a passive one.
 *
 * Grepping the shipped script, as in contextmenu-pointer-lock.test.ts: happy-dom has no
 * compositor, so no scroll there can ever be blocked on a listener.
 */
import { describe, it, expect } from 'bun:test';
import { IFRAME_CONTEXTMENU_SCRIPT } from '../iframe-scripts/contextmenu.js';

/** Source with `//` line comments dropped — the assertions are about code, not prose. */
function shippedCode(): string {
  return IFRAME_CONTEXTMENU_SCRIPT.split('\n')
    .map((line) => line.replace(/^\s*\/\/.*$/, ''))
    .join('\n');
}

describe('contextmenu script: touch relay', () => {
  it('registers no touch listener that can block scrolling', () => {
    expect(shippedCode()).not.toMatch(/passive:\s*false/);
  });

  it('keeps the touchmove relay registered as passive', () => {
    expect(shippedCode()).toMatch(
      /window\.addEventListener\('touchmove',[\s\S]*?\}, \{ passive: true \}\);/,
    );
  });

  it('keeps an overscroll from chaining out of the frame into the shell', () => {
    expect(shippedCode()).toContain('overscroll-behavior:none');
  });
});
