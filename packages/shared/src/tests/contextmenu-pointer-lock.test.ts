/**
 * A pointer-locked app keeps its window when Ctrl+W reaches it.
 *
 * A game holds W down to walk forward, so Ctrl+W there is a chord the player never
 * meant to type — and the escape hatch the shell offers other apps is closed to it:
 * `keybindingsClaimKey` only backs off for an app that *declares* a `w` combo, while
 * held-key movement is sampled through `createKeyState` and is never a command.
 * `ctrl+w` itself is reserved, so the app cannot declare its way out either.
 *
 * The order is the whole fix. `preventDefault()` must still run — unclaimed, Chrome
 * takes Ctrl+W and closes the YAAR browser window, which is a far worse outcome than
 * a dead shortcut — and only the *forward* to the shell is withheld. Folding the
 * pointer-lock test into the `dominated` check would read as the same behaviour and
 * silently restore that bug, so this asserts the guard sits below preventDefault.
 *
 * Grepping the shipped script, as in capture-inline-style.test.ts: it is a template
 * string injected into an iframe, and happy-dom has no pointer lock to drive it with.
 */
import { describe, it, expect } from 'bun:test';
import { IFRAME_CONTEXTMENU_SCRIPT } from '../iframe-scripts/contextmenu.js';

/** Source with `//` line comments dropped — the assertions are about code, not prose. */
function shippedCode(): string {
  return IFRAME_CONTEXTMENU_SCRIPT.split('\n')
    .map((line) => line.replace(/^\s*\/\/.*$/, ''))
    .join('\n');
}

describe('contextmenu script: Ctrl+W under pointer lock', () => {
  it('withholds the close forward while an element holds the lock', () => {
    expect(shippedCode()).toMatch(
      /if \(document\.pointerLockElement && e\.ctrlKey && e\.key\.toLowerCase\(\) === 'w'\) return;/,
    );
  });

  it('still claims the key from Chrome before withholding it', () => {
    const code = shippedCode();
    const prevented = code.indexOf('e.preventDefault();\n    e.stopImmediatePropagation();');
    const guard = code.indexOf('document.pointerLockElement');
    const forward = code.indexOf('(window.top || window.parent).postMessage');
    expect(prevented).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(prevented);
    expect(forward).toBeGreaterThan(guard);
  });

  it('leaves Shift+Tab and Ctrl+1-9 reachable, so the lock is escapable', () => {
    const guard = /if \(document\.pointerLockElement[^\n]*\) return;/.exec(shippedCode());
    expect(guard).not.toBeNull();
    expect(guard![0]).not.toMatch(/Tab/);
    expect(guard![0]).not.toMatch(/'1'/);
  });
});
