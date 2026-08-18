// ── IME probe ────────────────────────────────────────────────────────────
//
// A canvas cannot be composed into. An IME needs a real editable to attach to,
// and it needs one *locally*, in the desktop's own Chrome, because that is where
// the human's keyboard and their OS input method actually are. So the keyboard
// belongs to a hidden textarea parked over the canvas — the anchor — and the
// canvas only ever sees the mouse.
//
// What crosses the wire is therefore not keystrokes but composed text:
// `compositionupdate` → `Input.imeSetComposition` (the underlined preedit),
// `compositionend` → `Input.insertText` (the commit). Two consequences worth
// knowing before P0 builds on this:
//
//   - the remote page never learns which keys were pressed to compose, which is
//     correct — a real IME does not tell it either;
//   - the candidate window is drawn by the local OS at the *anchor's* caret, so
//     the anchor has to be moved onto the remote caret or the candidate list
//     appears in the wrong place. That is what `caret` frames are for, and how
//     well it works is the thing this probe exists to find out.
import { setImeStatus } from './state';
import { getAnchor, getCanvas, isLiveConnected, send, remoteW, remoteH } from './context';
import { markInput } from './stats';

let composing = false;

/** True while the IME owns this keystroke — ours to leave alone, not to forward. */
export function isImeKey(e: KeyboardEvent): boolean {
  // 229 is the "handled by IME" virtual key. Chrome fires the very first keydown
  // of a composition with it *before* compositionstart, so `composing` alone is
  // one keystroke too late.
  return composing || e.isComposing || e.keyCode === 229;
}

/** Give the keyboard to the anchor, so composition has something to attach to. */
export function focusRemoteKeyboard(): void {
  const anchor = getAnchor();
  if (anchor) anchor.focus({ preventScroll: true });
  else getCanvas()?.focus();
}

/** Leaving live mode: no preedit is in flight and the anchor keeps no shadow text. */
export function resetIme(): void {
  composing = false;
  setImeStatus('');
  const anchor = getAnchor();
  if (anchor) anchor.value = '';
}

export function onImeStart(): void {
  composing = true;
  setImeStatus('composing');
  markInput();
  requestCaret();
}

export function onImeUpdate(e: CompositionEvent): void {
  if (!isLiveConnected()) return;
  markInput();
  const text = e.data ?? '';
  // The caret sits at the end of the preedit: this is text being assembled, not
  // a selection the human is moving through.
  send({ t: 'ime', text, selStart: text.length, selEnd: text.length });
}

export function onImeEnd(e: CompositionEvent): void {
  composing = false;
  setImeStatus('');
  if (!isLiveConnected()) return;
  markInput();
  const text = e.data ?? '';
  // No data means the composition was erased rather than committed (backspacing
  // the last jamo). Empty text is CDP's cancel; without it the preedit would be
  // left standing in the remote page with nothing to finish it.
  if (text) send({ t: 'text', text });
  else send({ t: 'ime', text: '' });
  requestCaret(120);
}

/**
 * The anchor is an input sink, never a text field.
 *
 * Whatever the IME commits lands in the anchor's own value as well as going to
 * the remote page; left there it would accumulate a shadow copy of everything
 * ever typed, and the next composition would compose against it.
 */
export function onImeInput(): void {
  const anchor = getAnchor();
  if (composing || !anchor) return;
  anchor.value = '';
}

/**
 * Ask the remote page where its caret is.
 *
 * Debounced and delayed rather than sent per keystroke: the answer is a
 * `Runtime.evaluate` round trip, and it is only needed when the caret *moves* —
 * a click, a commit, the start of a composition.
 */
let caretTimer: ReturnType<typeof setTimeout> | null = null;

export function requestCaret(delayMs = 0): void {
  if (caretTimer) clearTimeout(caretTimer);
  caretTimer = setTimeout(() => {
    caretTimer = null;
    send({ t: 'caret' });
  }, delayMs);
}

/** Park the anchor at a point in the remote page — the inverse of `toRemote`. */
export function placeAnchor(x: number, y: number, h: number): void {
  const anchor = getAnchor();
  const canvas = getCanvas();
  if (!anchor || !canvas) return;
  const sx = canvas.clientWidth / (remoteW() || 1);
  const sy = canvas.clientHeight / (remoteH() || 1);
  anchor.style.left = `${Math.round(canvas.offsetLeft + x * sx)}px`;
  anchor.style.top = `${Math.round(canvas.offsetTop + y * sy)}px`;
  // The OS draws the candidate window immediately below the caret box, so the
  // height is what keeps the list from covering the line being typed.
  anchor.style.height = `${Math.max(12, Math.round(h * sy))}px`;
  if (composing) setImeStatus('composing');
}

/**
 * The remote page could not say where its caret is. The anchor stays where the
 * last click put it — an approximation is better than a candidate window in the
 * corner — so the readout is what says the placement is a guess.
 */
export function reportNoCaret(): void {
  setImeStatus(composing ? 'composing (guessed caret)' : 'no caret');
}
