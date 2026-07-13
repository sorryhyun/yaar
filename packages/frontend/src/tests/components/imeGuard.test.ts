import { describe, it, expect, beforeEach } from 'bun:test';
import { GlobalWindow, type HTMLInputElement, type KeyboardEvent } from 'happy-dom';
import { IFRAME_IME_GUARD_SCRIPT } from '@yaar/shared';

/**
 * The guard injected into app iframes relies on a capture-phase listener on
 * `window` sitting above every app handler in the dispatch path. These tests
 * pin that behaviour: keydowns belonging to an in-progress IME composition must
 * never reach an app's own handler, while ordinary keys must pass through
 * untouched.
 *
 * Each test builds its own window rather than leaning on the ambient DOM
 * globals, both because the script latches itself onto the window it installs
 * into (so tests need a fresh one) and because `navigator.platform` is what
 * decides whether it installs at all — an injected navigator is how we pin the
 * macOS-only behaviour without mutating a shared global.
 */
describe('IFRAME_IME_GUARD_SCRIPT', () => {
  let win: GlobalWindow;
  let input: HTMLInputElement;
  let seen: number[];

  beforeEach(() => {
    win = new GlobalWindow();
    seen = [];
    input = win.document.createElement('input') as HTMLInputElement;
    win.document.body.appendChild(input);
    // Stand in for an app's own Enter-to-submit handler.
    input.addEventListener('keydown', (e) => seen.push((e as KeyboardEvent).keyCode));
  });

  /**
   * The script reads `window` and `navigator` as free variables; passing them in
   * as parameters scopes it to this test's window exactly as the iframe's own
   * globals would.
   */
  function install(platform = 'MacIntel') {
    new Function('window', 'navigator', IFRAME_IME_GUARD_SCRIPT)(win, { platform });
  }

  function press(init: { key: string; keyCode: number; isComposing?: boolean }) {
    input.dispatchEvent(
      new win.KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true }),
    );
  }

  it('hides the Chrome commit Enter (isComposing) from app handlers', () => {
    install();
    press({ key: 'Enter', keyCode: 229, isComposing: true });
    expect(seen).toEqual([]);
  });

  it('hides the Safari commit Enter (keyCode 229, isComposing already false)', () => {
    install();
    press({ key: 'Enter', keyCode: 229, isComposing: false });
    expect(seen).toEqual([]);
  });

  it('lets the real Enter through once composition has ended', () => {
    install();
    press({ key: 'Enter', keyCode: 13, isComposing: false });
    expect(seen).toEqual([13]);
  });

  it('leaves ordinary typing untouched', () => {
    install();
    press({ key: 'a', keyCode: 65 });
    press({ key: 'Escape', keyCode: 27 });
    expect(seen).toEqual([65, 27]);
  });

  it('installs only once per window', () => {
    install();
    install();
    press({ key: 'Enter', keyCode: 13 });
    expect(seen).toEqual([13]);
    expect((win as unknown as Record<string, unknown>).__yaarImeGuardInstalled).toBe(true);
  });

  it('does not preventDefault — the IME still needs the key', () => {
    install();
    const e = new win.KeyboardEvent('keydown', {
      key: 'Enter',
      keyCode: 229,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });

  it('stays out of the way on Windows, where the commit Enter arrives only once', () => {
    install('Win32');
    press({ key: 'Enter', keyCode: 229, isComposing: true });
    expect(seen).toEqual([229]);
  });
});
