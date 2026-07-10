/**
 * IME composition guard for Enter-to-submit inputs.
 *
 * With a composing IME (Korean, Japanese, Chinese), the Enter that commits the
 * in-progress syllable is delivered as a keydown. Browsers disagree on how:
 * Chrome fires keydown (isComposing=true) then compositionend; Safari fires
 * compositionend first, so isComposing is already false. Both, however, report
 * keyCode 229 for the committing key. Checking each alone misses one browser.
 *
 * Without this guard the commit Enter submits, and the follow-up Enter that
 * browsers fire once composition ends submits again — sending the just-committed
 * trailing character as a second message.
 */
import type { KeyboardEvent } from 'react';

export function isComposingKey(e: KeyboardEvent<HTMLElement>): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229;
}
