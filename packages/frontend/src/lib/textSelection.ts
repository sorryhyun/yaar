/**
 * The phone's own text selection.
 *
 * On a phone, a native selection brings up Chrome's selection toolbar — web search, "look
 * up", and nothing a page can remove or reorder. The only way out is `user-select: none`,
 * which takes the selection away with the toolbar. So window content on a phone is
 * unselectable, and the shell selects by itself: a long-press picks the word under the
 * finger, and the range is painted with the CSS Custom Highlight API (`::highlight`) rather
 * than put in the document's `Selection`, which is what would summon the toolbar.
 *
 * One selection at a time, held here rather than in the store: it is a live `Range` into
 * the DOM, and `beginShellDrag` has to be able to clear it without a React tree to ask.
 */

const HIGHLIGHT_NAME = 'yaar-selection';

export interface TextSelection {
  range: Range;
  windowId: string;
}

let current: TextSelection | null = null;
const listeners = new Set<() => void>();

function publish(next: TextSelection | null): void {
  current = next;
  const highlights = globalThis.CSS?.highlights;
  if (highlights) {
    if (next) highlights.set(HIGHLIGHT_NAME, new Highlight(next.range));
    else highlights.delete(HIGHLIGHT_NAME);
  }
  for (const listener of listeners) listener();
}

export function getTextSelection(): TextSelection | null {
  return current;
}

export function setTextSelection(range: Range, windowId: string): void {
  publish({ range, windowId });
}

export function clearTextSelection(): void {
  if (current) publish(null);
}

/** `useSyncExternalStore`'s subscribe. */
export function subscribeTextSelection(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Whether the touch in progress has become a long-press. `PhoneGestures` asks on every
 * move and lets go of a touch that has: a finger that held still long enough to select a
 * word is not the start of a pan or a pull, whichever way it moves next.
 */
let touchClaimed = false;

export function claimTouch(): void {
  touchClaimed = true;
}

export function releaseTouch(): void {
  touchClaimed = false;
}

export function isTouchClaimed(): boolean {
  return touchClaimed;
}

let segmenter: Intl.Segmenter | null = null;

/**
 * The word around caret position `offset` in `text`, as `[start, end)`, or null when the
 * caret touches none. A caret sits *between* characters, and the one the finger was on can
 * be either side of it — right half of the last letter of a word puts the caret after it —
 * so the character after the caret is tried first and the one before it second.
 *
 * `Intl.Segmenter` is what makes this work for text with no spaces to split on (Chinese,
 * Japanese) and for Hangul, where a space-separated run is one word.
 */
export function wordBounds(text: string, offset: number): [number, number] | null {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'word' });
  const segments = segmenter.segment(text);
  for (const at of [offset, offset - 1]) {
    if (at < 0 || at >= text.length) continue;
    const seg = segments.containing(at);
    if (seg?.isWordLike) return [seg.index, seg.index + seg.segment.length];
  }
  return null;
}

type CaretDocument = Document & {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

/**
 * The caret position under a point. The hit test ignores `user-select: none` — checked
 * against Chrome 151, it lands on the letter under the point either way — so the content
 * can stay unselectable while it is probed.
 */
export function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as CaretDocument;
  if (doc.caretPositionFromPoint) {
    const pos = doc.caretPositionFromPoint(x, y);
    return pos ? { node: pos.offsetNode, offset: pos.offset } : null;
  }
  const range = doc.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

/** The word under a point inside `within`, as a range, or null over anything but a word. */
export function wordRangeAt(within: HTMLElement, x: number, y: number): Range | null {
  const caret = caretAt(x, y);
  if (!caret || caret.node.nodeType !== Node.TEXT_NODE || !within.contains(caret.node)) {
    return null;
  }
  const bounds = wordBounds(caret.node.textContent ?? '', caret.offset);
  if (!bounds) return null;
  const range = document.createRange();
  range.setStart(caret.node, bounds[0]);
  range.setEnd(caret.node, bounds[1]);
  return range;
}

/** Every piece of text inside `within`, as one range — the menu's "Select all". */
export function rangeAll(within: HTMLElement): Range {
  const range = document.createRange();
  range.selectNodeContents(within);
  return range;
}
