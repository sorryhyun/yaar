import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { IFRAME_IME_GUARD_SCRIPT } from '@yaar/shared';

/**
 * The guard injected into app iframes relies on a capture-phase listener on
 * `window` sitting above every app handler in the dispatch path. These tests
 * pin that behaviour: keydowns belonging to an in-progress IME composition must
 * never reach an app's own handler, while ordinary keys must pass through
 * untouched.
 */
describe('IFRAME_IME_GUARD_SCRIPT', () => {
  let input: HTMLInputElement;
  let seen: number[];

  beforeEach(() => {
    // The script self-installs once per window; reset the latch between tests.
    delete (globalThis.window as unknown as Record<string, unknown>).__yaarImeGuardInstalled;

    seen = [];
    input = document.createElement('input');
    document.body.appendChild(input);
    // Stand in for an app's own Enter-to-submit handler.
    input.addEventListener('keydown', (e) => seen.push((e as KeyboardEvent).keyCode));
  });

  afterEach(() => {
    input.remove();
  });

  function install() {
    new Function(IFRAME_IME_GUARD_SCRIPT).call(globalThis.window);
  }

  function press(init: { key: string; keyCode: number; isComposing?: boolean }) {
    input.dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true }));
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
    expect((globalThis.window as unknown as Record<string, unknown>).__yaarImeGuardInstalled).toBe(
      true,
    );
  });

  it('does not preventDefault — the IME still needs the key', () => {
    install();
    const e = new KeyboardEvent('keydown', {
      key: 'Enter',
      keyCode: 229,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });
});
