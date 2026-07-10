/**
 * IME composition guard injected into app iframes.
 *
 * While a composing IME (Korean, Japanese, Chinese) is assembling a character,
 * the keys the user presses belong to the IME, not to the app. Browsers still
 * dispatch keydown for them — notably the Enter that commits the in-progress
 * syllable. An app that submits on Enter therefore fires early, and the
 * follow-up Enter the browser delivers once composition ends fires a second
 * time, sending the just-committed trailing character on its own.
 *
 * Rather than require every app to guard its own handlers, we swallow these
 * keydowns once, here. A capture-phase listener on `window` sits above every
 * app handler in the dispatch path, so stopping propagation there hides the
 * event from element listeners and framework-delegated roots (React, Solid)
 * alike, whatever order they registered in.
 *
 * Detection needs both checks: Chrome fires the commit keydown *before*
 * `compositionend` (so `isComposing` is true), while Safari fires
 * `compositionend` *first* (so `isComposing` is already false). Only the
 * legacy `keyCode === 229` is reported by both.
 *
 * We never call preventDefault — the IME needs the key to do its own work, and
 * stopping propagation does not affect a key's default action.
 */
export const IFRAME_IME_GUARD_SCRIPT = `
(function() {
  if (window.__yaarImeGuardInstalled) return;
  window.__yaarImeGuardInstalled = true;

  window.addEventListener('keydown', function(e) {
    if (e.isComposing || e.keyCode === 229) {
      e.stopPropagation();
    }
  }, true);
})();
`;
