/**
 * Autofill opt-out injected into app iframes, and run once on the shell's own document.
 *
 * Nothing YAAR draws is a login, checkout or address form, but Chrome cannot tell: on
 * Android every text field it deems fillable grows the keyboard accessory bar (the key,
 * card and pin icons of saved passwords, payment methods and addresses), and the desktop
 * build drops its suggestion list over the same fields. So a chat box or a search field
 * reads as a password prompt. Every text control therefore gets `autocomplete="off"`
 * stamped on it as it enters the DOM — the observer, not a focus listener, because
 * Chrome classifies a field when it sees it, before any focus event an app could hook.
 *
 * Two kinds of control are left alone: one that already carries an `autocomplete`
 * attribute (an app asking for `email` or `one-time-code` meant it), and a password
 * field, where the password manager is the point.
 */
import { installGuard } from './prelude.js';
export const IFRAME_AUTOFILL_GUARD_SCRIPT = `
(function() {
  ${installGuard('__yaarAutofillGuardInstalled')}
  if (typeof MutationObserver === 'undefined') return;

  function stamp(el) {
    if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return;
    if (el.type === 'password' || el.hasAttribute('autocomplete')) return;
    el.setAttribute('autocomplete', 'off');
  }

  function sweep(node) {
    if (node.nodeType !== 1) return;
    stamp(node);
    var fields = node.querySelectorAll('input, textarea');
    for (var i = 0; i < fields.length; i++) stamp(fields[i]);
  }

  new MutationObserver(function(records) {
    for (var i = 0; i < records.length; i++) {
      var added = records[i].addedNodes;
      for (var j = 0; j < added.length; j++) sweep(added[j]);
    }
  }).observe(document, { childList: true, subtree: true });

  if (document.documentElement) sweep(document.documentElement);
})();
`;
