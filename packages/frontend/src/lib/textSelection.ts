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
 * The range lives in one of two documents. In a window the shell renders itself it is a
 * `Range` here (`kind: 'shell'`). In an app card it is a `Range` inside the frame, kept and
 * painted by the frame's own script (`@yaar/shared`'s `iframe-scripts/text-selection.ts`),
 * which reports where it is; the shell holds that report (`kind: 'frame'`) and sends back
 * what to do to it. Either way the handles and the menu are drawn here, from
 * `selectionGeometry`, so there is one set of them.
 *
 * One selection at a time, held here rather than in the store: it is a live `Range` into
 * the DOM, and `beginShellDrag` has to be able to clear it without a React tree to ask.
 */
import { APP_MSG } from '@yaar/shared';

const HIGHLIGHT_NAME = 'yaar-selection';

/** How close to the edge of what scrolls a dragged handle starts scrolling it. */
const AUTO_SCROLL_EDGE_PX = 40;
/** The most one frame of that scroll moves, reached at the edge itself. */
const AUTO_SCROLL_MAX_PX = 16;

/** Which end of a selection: the handles are named after them. */
export type SelectionEnd = 'start' | 'end';

/** A vertical line at one end of a selection — where the caret would sit, top to bottom. */
export interface CaretLine {
  x: number;
  top: number;
  bottom: number;
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ShellTextSelection {
  kind: 'shell';
  range: Range;
  windowId: string;
}

/** A selection inside an app frame, as the frame last reported it (frame coordinates). */
export interface FrameTextSelection {
  kind: 'frame';
  iframe: HTMLIFrameElement;
  windowId: string;
  text: string;
  start: CaretLine;
  end: CaretLine;
  bounds: Box;
  /** The box of what scrolls the text inside the frame, when something does. */
  clip?: Box;
}

export type TextSelection = ShellTextSelection | FrameTextSelection;

/** What the overlay draws from, in viewport coordinates. */
export interface SelectionGeometry {
  start: CaretLine;
  end: CaretLine;
  bounds: Box;
  /**
   * What the text shows through — the window, narrowed to what scrolls it inside the
   * window when something does. A handle outside it is not drawn.
   */
  clip: Box;
}

let current: TextSelection | null = null;
const listeners = new Set<() => void>();

type SelectionCommand =
  | { op: 'clear' | 'selectAll' | 'dragEnd' }
  | { op: 'dragStart'; end: SelectionEnd }
  | { op: 'drag'; x: number; y: number };

// Nothing in a command is private, so any origin may have it — as `iframe-bridge/device.ts`.
function tellFrame(iframe: HTMLIFrameElement, command: SelectionCommand): void {
  iframe.contentWindow?.postMessage({ type: APP_MSG.textSelectionCommand, ...command }, '*');
}

/**
 * `tell` is false when the frame itself reported the selection gone: it has let go
 * already, and does not need telling.
 */
function publish(next: TextSelection | null, tell = true): void {
  const prev = current;
  current = next;
  if (tell && prev?.kind === 'frame' && !(next?.kind === 'frame' && next.iframe === prev.iframe)) {
    tellFrame(prev.iframe, { op: 'clear' });
  }
  const highlights = globalThis.CSS?.highlights;
  if (highlights) {
    if (next?.kind === 'shell') highlights.set(HIGHLIGHT_NAME, new Highlight(next.range));
    else highlights.delete(HIGHLIGHT_NAME);
  }
  for (const listener of listeners) listener();
}

export function getTextSelection(): TextSelection | null {
  return current;
}

export function setTextSelection(range: Range, windowId: string): void {
  publish({ kind: 'shell', range, windowId });
}

/** What an app frame reported (`APP_MSG.textSelection`), already validated. */
export interface FrameSelectionReport {
  text?: string;
  start: CaretLine;
  end: CaretLine;
  bounds: Box;
  clip?: Box;
}

/** Take a frame's report of its selection; `null` is the frame saying it has none. */
export function setFrameTextSelection(
  iframe: HTMLIFrameElement,
  windowId: string,
  report: FrameSelectionReport | null,
): void {
  const prev = current?.kind === 'frame' && current.iframe === iframe ? current : null;
  if (!report) {
    if (prev) publish(null, false);
    return;
  }
  // A report that only moved the range leaves the text out. With nothing held for this
  // frame, it is one that crossed the desktop's own clear on the way, and is stale.
  if (report.text === undefined && !prev) return;
  const text = report.text ?? prev?.text ?? '';
  const { start, end, bounds, clip } = report;
  publish({ kind: 'frame', iframe, windowId, text, start, end, bounds, clip });
}

export function clearTextSelection(): void {
  if (current) publish(null);
}

/** `useSyncExternalStore`'s subscribe. */
export function subscribeTextSelection(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function selectionText(selection: TextSelection): string {
  return selection.kind === 'shell' ? selection.range.toString() : selection.text;
}

/** The window content box a range sits in. */
export function contentOf(range: Range): HTMLElement | null {
  const start = range.startContainer;
  const el = start instanceof Element ? start : start.parentElement;
  return el?.closest<HTMLElement>('[data-window-content]') ?? null;
}

function boxOf(rect: DOMRectReadOnly): Box {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

function intersect(a: Box, b: Box): Box {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/**
 * Where a selection is on screen now, or null when a shell range's text has been
 * re-rendered away. A frame's report is translated by where the frame is now, so a
 * frame that moved (a scroll of the shell) needs no new report.
 */
export function selectionGeometry(selection: TextSelection): SelectionGeometry | null {
  if (selection.kind === 'shell') {
    const { range } = selection;
    if (!range.startContainer.isConnected || !range.endContainer.isConnected) return null;
    const content = contentOf(range);
    if (!content) return null;
    const window = boxOf(content.getBoundingClientRect());
    const scroller = scrollerOf(range.commonAncestorContainer, content);
    return {
      start: caretLine(range, 'start'),
      end: caretLine(range, 'end'),
      bounds: boxOf(range.getBoundingClientRect()),
      clip:
        scroller === content ? window : intersect(window, boxOf(scroller.getBoundingClientRect())),
    };
  }
  const { iframe } = selection;
  if (!iframe.isConnected) return null;
  const frame = iframe.getBoundingClientRect();
  const line = (l: CaretLine): CaretLine => ({
    x: l.x + frame.left,
    top: l.top + frame.top,
    bottom: l.bottom + frame.top,
  });
  const shift = (b: Box): Box => ({ ...b, left: b.left + frame.left, top: b.top + frame.top });
  const window = boxOf(frame);
  return {
    start: line(selection.start),
    end: line(selection.end),
    bounds: shift(selection.bounds),
    clip: selection.clip ? intersect(window, shift(selection.clip)) : window,
  };
}

/** The menu's "Select all": everything in the window the selection is in. */
export function selectAll(selection: TextSelection): void {
  if (selection.kind === 'frame') {
    tellFrame(selection.iframe, { op: 'selectAll' });
    return;
  }
  const content = contentOf(selection.range);
  const range = content && rangeAll(content);
  if (range) setTextSelection(range, selection.windowId);
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
  const caret = textCaretAt(within, x, y);
  if (!caret) return null;
  const bounds = wordBounds(caret.node.textContent ?? '', caret.offset);
  if (!bounds) return null;
  const range = document.createRange();
  range.setStart(caret.node, bounds[0]);
  range.setEnd(caret.node, bounds[1]);
  return range;
}

/** Where selecting is not ours: fields keep the native selection, controls are pressed. */
export const NOT_SELECTABLE =
  'input, textarea, select, button, [contenteditable]:not([contenteditable="false"]), [data-no-select]';

/** The caret under a point, if it sits in text inside `within` that a selection may hold. */
function textCaretAt(within: HTMLElement, x: number, y: number) {
  const caret = caretAt(x, y);
  if (!caret || caret.node.nodeType !== Node.TEXT_NODE || !within.contains(caret.node)) {
    return null;
  }
  return caret.node.parentElement?.closest(NOT_SELECTABLE) ? null : caret;
}

function shown(node: Text): boolean {
  const el = node.parentElement;
  if (!el || el.closest(`script, style, noscript, template, ${NOT_SELECTABLE}`)) return false;
  return typeof el.checkVisibility !== 'function' || el.checkVisibility();
}

/**
 * The menu's "Select all": from the first piece of text inside `within` that shows to the
 * last. Not `selectNodeContents`, whose ends sit on the element either side of the text
 * and so give the handles no line to hang from. Null when there is no text at all.
 */
export function rangeAll(within: HTMLElement): Range | null {
  const walker = document.createTreeWalker(within, 4 /* SHOW_TEXT */);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (/\S/.test((n as Text).data)) nodes.push(n as Text);
  }
  const first = nodes.find(shown);
  let last: Text | undefined;
  for (let i = nodes.length - 1; i >= 0 && !last; i--) if (shown(nodes[i])) last = nodes[i];
  if (!first || !last) return null;
  const range = document.createRange();
  range.setStart(first, 0);
  range.setEnd(last, last.data.length);
  return range;
}

interface Caret {
  node: Node;
  offset: number;
}

/** The range from one caret to another, whichever comes first; null if they meet. */
export function spanBetween(a: Caret, b: Caret): Range | null {
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  // An end before the start collapses the range onto it: then the two are the other way round.
  range.setEnd(b.node, b.offset);
  if (range.collapsed) {
    range.setStart(b.node, b.offset);
    range.setEnd(a.node, a.offset);
  }
  return range.collapsed ? null : range;
}

/**
 * The caret line at one end of a range. A collapsed range measures as the caret itself;
 * one that measures nothing — its end is on an element, not in text — falls back to the
 * edge of the first or last box the range covers.
 */
export function caretLine(range: Range, end: SelectionEnd): CaretLine {
  const atStart = end === 'start';
  const caret = range.cloneRange();
  caret.collapse(atStart);
  const box = caret.getBoundingClientRect();
  if (box.height) return { x: box.left, top: box.top, bottom: box.bottom };
  const rects = range.getClientRects();
  const edge = rects.length ? rects[atStart ? 0 : rects.length - 1] : range.getBoundingClientRect();
  return { x: atStart ? edge.left : edge.right, top: edge.top, bottom: edge.bottom };
}

/** A drag of one handle, fed the finger's viewport position until it lifts. */
export interface HandleDrag {
  to(x: number, y: number): void;
  end(): void;
}

/**
 * Start dragging the handle at `end` of the selection, from a finger at (`x`, `y`).
 *
 * The finger sits under the handle, which hangs under the line, so it is the point the
 * handle *marks* that follows the finger: the caret line's middle, kept at the offset it
 * had from the finger when the drag began. The other end stays where it is — the anchor —
 * and a dragged end that crosses it simply becomes the other end.
 *
 * A finger held near the top or bottom of what scrolls the text scrolls it, faster the
 * closer it is, and the end is re-probed each frame for the text that scrolled under it.
 * In a frame all of that is the frame's to do; here it is only told where the finger is.
 */
export function dragHandle(
  selection: TextSelection,
  end: SelectionEnd,
  x: number,
  y: number,
): HandleDrag | null {
  const geometry = selectionGeometry(selection);
  if (!geometry) return null;
  const line = geometry[end];
  const dx = line.x - x;
  const dy = (line.top + line.bottom) / 2 - y;

  if (selection.kind === 'frame') {
    const { iframe } = selection;
    tellFrame(iframe, { op: 'dragStart', end });
    return {
      to(fx, fy) {
        const frame = iframe.getBoundingClientRect();
        tellFrame(iframe, { op: 'drag', x: fx + dx - frame.left, y: fy + dy - frame.top });
      },
      end() {
        tellFrame(iframe, { op: 'dragEnd' });
      },
    };
  }

  const { range, windowId } = selection;
  const content = contentOf(range);
  if (!content) return null;
  const anchor: Caret =
    end === 'start'
      ? { node: range.endContainer, offset: range.endOffset }
      : { node: range.startContainer, offset: range.startOffset };
  const scroller = scrollerOf(anchor.node, content);
  let px = 0;
  let py = 0;
  let frame = 0;

  const extend = () => {
    const box = scroller.getBoundingClientRect();
    const caret = textCaretAt(
      content,
      Math.min(Math.max(px, box.left + 1), box.right - 1),
      Math.min(Math.max(py, box.top + 1), box.bottom - 1),
    );
    const next = caret && spanBetween(anchor, caret);
    if (next) setTextSelection(next, windowId);
  };

  const autoScroll = () => {
    frame = 0;
    const box = scroller.getBoundingClientRect();
    const step = autoScrollStep(py, box.top, box.bottom);
    if (!step) return;
    const before = scroller.scrollTop;
    scroller.scrollTop = before + step;
    if (scroller.scrollTop === before) return;
    extend();
    frame = requestAnimationFrame(autoScroll);
  };

  return {
    to(fx, fy) {
      px = fx + dx;
      py = fy + dy;
      extend();
      if (!frame) frame = requestAnimationFrame(autoScroll);
    },
    end() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    },
  };
}

/** How far to scroll this frame for a finger at `y` over a scroller spanning `top`–`bottom`. */
export function autoScrollStep(y: number, top: number, bottom: number): number {
  const edge = AUTO_SCROLL_EDGE_PX;
  if (y < top + edge) {
    return -Math.ceil(AUTO_SCROLL_MAX_PX * Math.min(1, (top + edge - y) / edge));
  }
  if (y > bottom - edge) {
    return Math.ceil(AUTO_SCROLL_MAX_PX * Math.min(1, (y - bottom + edge) / edge));
  }
  return 0;
}

/** What scrolls the text at `node` — the nearest scroller up to `within`, else `within`. */
function scrollerOf(node: Node, within: HTMLElement): Element {
  for (
    let el: Element | null = node instanceof Element ? node : node.parentElement;
    el && el !== within;
    el = el.parentElement
  ) {
    if (el.scrollHeight <= el.clientHeight + 1) continue;
    const { overflowY } = getComputedStyle(el);
    if (overflowY === 'auto' || overflowY === 'scroll') return el;
  }
  return within;
}
