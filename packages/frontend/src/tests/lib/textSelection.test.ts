/**
 * The phone's own text selection: which word a caret lands in, the ranges a handle drag
 * and Select all make, and the one selection the shell holds — published to the highlight
 * registry, cleared by a shell drag, and, for one inside an app frame, kept in step with
 * what the frame reports and told what the menu and the handles did.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { APP_MSG } from '@yaar/shared';
import {
  autoScrollStep,
  caretAt,
  claimTouch,
  clearTextSelection,
  dragHandle,
  getTextSelection,
  isTouchClaimed,
  rangeAll,
  releaseTouch,
  selectAll,
  selectionGeometry,
  selectionText,
  setFrameTextSelection,
  setTextSelection,
  spanBetween,
  subscribeTextSelection,
  wordBounds,
  wordRangeAt,
} from '@/lib/textSelection';
import { beginShellDrag } from '@/lib/selection';

const word = (text: string, offset: number) => {
  const b = wordBounds(text, offset);
  return b && text.slice(b[0], b[1]);
};

describe('wordBounds', () => {
  it('selects the word the caret is inside', () => {
    expect(word('hello brave world', 8)).toBe('brave');
  });

  it('takes the word on the left of a caret that sits just after it', () => {
    // Right half of the last letter puts the caret on the space after the word.
    expect(word('hello brave world', 11)).toBe('brave');
    expect(word('hello', 5)).toBe('hello');
  });

  it('prefers the word after the caret when it sits between two', () => {
    expect(word('hello brave', 6)).toBe('brave');
  });

  it('selects nothing in a run of whitespace or punctuation', () => {
    expect(wordBounds('a   b', 2)).toBeNull();
    expect(wordBounds('hi — there', 3)).toBeNull();
    expect(wordBounds('', 0)).toBeNull();
  });

  it('keeps a space-separated Hangul run together', () => {
    expect(word('안녕하세요 여러분', 2)).toBe('안녕하세요');
    expect(word('안녕하세요 여러분', 7)).toBe('여러분');
  });

  it('keeps a number with its separators', () => {
    expect(word('costs 1,234.50 today', 8)).toBe('1,234.50');
  });
});

describe('caret probing', () => {
  const doc = document as unknown as { caretRangeFromPoint?: unknown };
  let content: HTMLElement;
  let text: Text;

  beforeEach(() => {
    content = document.createElement('div');
    text = document.createTextNode('select this word');
    content.appendChild(text);
    document.body.appendChild(content);
  });

  afterEach(() => {
    content.remove();
    delete doc.caretRangeFromPoint;
  });

  function caretOn(node: Node, offset: number) {
    doc.caretRangeFromPoint = () => {
      const r = document.createRange();
      r.setStart(node, offset);
      return r;
    };
  }

  it('reads the caret off the hit test', () => {
    caretOn(text, 2);
    expect(caretAt(0, 0)).toEqual({ node: text, offset: 2 });
  });

  it('turns the caret into the range of its word', () => {
    caretOn(text, 9);
    expect(wordRangeAt(content, 0, 0)?.toString()).toBe('this');
  });

  it('refuses a caret outside the content, or not in text', () => {
    const outside = document.createTextNode('elsewhere');
    document.body.appendChild(outside);
    caretOn(outside, 2);
    expect(wordRangeAt(content, 0, 0)).toBeNull();
    outside.remove();

    caretOn(content, 0);
    expect(wordRangeAt(content, 0, 0)).toBeNull();
  });
});

describe('the selection', () => {
  const g = globalThis as unknown as { CSS?: unknown; Highlight?: unknown };
  const registry = new Map<string, { ranges: Range[] }>();
  let savedCSS: unknown;
  let savedHighlight: unknown;

  beforeEach(() => {
    savedCSS = g.CSS;
    savedHighlight = g.Highlight;
    registry.clear();
    g.CSS = { highlights: registry };
    g.Highlight = class {
      ranges: Range[];
      constructor(...ranges: Range[]) {
        this.ranges = ranges;
      }
    };
  });

  afterEach(() => {
    clearTextSelection();
    releaseTouch();
    g.CSS = savedCSS;
    g.Highlight = savedHighlight;
  });

  it('paints the range as the yaar-selection highlight, and takes it away on clear', () => {
    const range = document.createRange();
    setTextSelection(range, 'w1');
    expect(getTextSelection()).toEqual({ kind: 'shell', range, windowId: 'w1' });
    expect(registry.get('yaar-selection')?.ranges).toEqual([range]);

    clearTextSelection();
    expect(getTextSelection()).toBeNull();
    expect(registry.has('yaar-selection')).toBe(false);
  });

  it('tells subscribers, and stops when they unsubscribe', () => {
    let calls = 0;
    const unsubscribe = subscribeTextSelection(() => calls++);
    setTextSelection(document.createRange(), 'w1');
    clearTextSelection();
    clearTextSelection(); // nothing to clear — no news
    expect(calls).toBe(2);
    unsubscribe();
    setTextSelection(document.createRange(), 'w1');
    expect(calls).toBe(2);
  });

  it('is cleared by a shell drag, like the native selection', () => {
    setTextSelection(document.createRange(), 'w1');
    beginShellDrag({ preventDefault: () => {} });
    expect(getTextSelection()).toBeNull();
  });

  it('tracks whether the touch in progress was claimed', () => {
    expect(isTouchClaimed()).toBe(false);
    claimTouch();
    expect(isTouchClaimed()).toBe(true);
    releaseTouch();
    expect(isTouchClaimed()).toBe(false);
  });
});

describe('ranges', () => {
  let content: HTMLElement;

  beforeEach(() => {
    content = document.createElement('div');
    document.body.appendChild(content);
  });

  afterEach(() => content.remove());

  it('spans two carets whichever order they come in, and nothing when they meet', () => {
    const text = document.createTextNode('one two three');
    content.appendChild(text);
    expect(spanBetween({ node: text, offset: 4 }, { node: text, offset: 13 })?.toString()).toBe(
      'two three',
    );
    expect(spanBetween({ node: text, offset: 7 }, { node: text, offset: 0 })?.toString()).toBe(
      'one two',
    );
    expect(spanBetween({ node: text, offset: 3 }, { node: text, offset: 3 })).toBeNull();
  });

  it('spans paragraphs', () => {
    content.innerHTML = '<p>first para</p><p>second para</p>';
    const [a, b] = [content.children[0].firstChild!, content.children[1].firstChild!];
    expect(spanBetween({ node: b, offset: 6 }, { node: a, offset: 6 })?.toString()).toBe(
      'parasecond',
    );
  });

  it('selects all from the first piece of text to the last, not the empty ones', () => {
    content.innerHTML = '\n  <p>  first</p><script>no()</script><p>last  </p>\n';
    const range = rangeAll(content)!;
    expect(range.startContainer).toBe(content.querySelector('p')!.firstChild!);
    expect(range.startOffset).toBe(0);
    expect(range.toString()).toBe('  firstno()last  ');
    expect(rangeAll(document.createElement('div'))).toBeNull();
  });

  it('scrolls faster the closer a handle gets to the edge, and not at all away from it', () => {
    expect(autoScrollStep(300, 0, 600)).toBe(0);
    expect(autoScrollStep(30, 0, 600)).toBeLessThan(0);
    expect(autoScrollStep(5, 0, 600)).toBeLessThan(autoScrollStep(30, 0, 600));
    expect(autoScrollStep(-200, 0, 600)).toBe(-16);
    expect(autoScrollStep(590, 0, 600)).toBeGreaterThan(0);
    expect(autoScrollStep(900, 0, 600)).toBe(16);
  });
});

describe('a selection inside an app frame', () => {
  const posted: unknown[] = [];
  const iframe = {
    isConnected: true,
    contentWindow: { postMessage: (m: unknown) => posted.push(m) },
    getBoundingClientRect: () => ({ left: 10, top: 100, width: 400, height: 600 }),
  } as unknown as HTMLIFrameElement;
  const report = {
    text: 'hello',
    start: { x: 5, top: 20, bottom: 40 },
    end: { x: 50, top: 20, bottom: 40 },
    bounds: { left: 5, top: 20, width: 45, height: 20 },
  };

  beforeEach(() => {
    posted.length = 0;
  });

  afterEach(() => clearTextSelection());

  it('is held as the frame reported it, and placed where the frame is', () => {
    setFrameTextSelection(iframe, 'w1', report);
    const selection = getTextSelection()!;
    expect(selection.kind).toBe('frame');
    expect(selectionText(selection)).toBe('hello');
    const geometry = selectionGeometry(selection)!;
    expect(geometry.start).toEqual({ x: 15, top: 120, bottom: 140 });
    expect(geometry.bounds).toEqual({ left: 15, top: 120, width: 45, height: 20 });
    expect(geometry.clip).toEqual({ left: 10, top: 100, width: 400, height: 600 });
  });

  it('keeps the text through a report that only moved it', () => {
    setFrameTextSelection(iframe, 'w1', report);
    setFrameTextSelection(iframe, 'w1', {
      ...report,
      text: undefined,
      bounds: { ...report.bounds, top: 0 },
    });
    const selection = getTextSelection()!;
    expect(selectionText(selection)).toBe('hello');
    expect(selectionGeometry(selection)!.bounds.top).toBe(100);
  });

  it('ignores a move from a frame it holds nothing for — one that crossed a clear', () => {
    setFrameTextSelection(iframe, 'w1', { ...report, text: undefined });
    expect(getTextSelection()).toBeNull();
  });

  it('tells the frame when it lets go, but not when the frame let go first', () => {
    setFrameTextSelection(iframe, 'w1', report);
    clearTextSelection();
    expect(posted).toEqual([{ type: APP_MSG.textSelectionCommand, op: 'clear' }]);

    posted.length = 0;
    setFrameTextSelection(iframe, 'w1', report);
    setFrameTextSelection(iframe, 'w1', null);
    expect(getTextSelection()).toBeNull();
    expect(posted).toEqual([]);
  });

  it('tells the frame when a selection elsewhere replaces its own', () => {
    setFrameTextSelection(iframe, 'w1', report);
    setTextSelection(document.createRange(), 'w2');
    expect(posted).toEqual([{ type: APP_MSG.textSelectionCommand, op: 'clear' }]);
  });

  it('hands Select all and a handle drag to the frame, in its own coordinates', () => {
    setFrameTextSelection(iframe, 'w1', report);
    selectAll(getTextSelection()!);
    // The finger lands 20px under the end line's middle (x 60, y 130 on screen).
    const drag = dragHandle(getTextSelection()!, 'end', 60, 150)!;
    drag.to(80, 250);
    drag.end();
    expect(posted).toEqual([
      { type: APP_MSG.textSelectionCommand, op: 'selectAll' },
      { type: APP_MSG.textSelectionCommand, op: 'dragStart', end: 'end' },
      // Where the line's middle follows the finger to, less the frame's offset.
      { type: APP_MSG.textSelectionCommand, op: 'drag', x: 70, y: 130 },
      { type: APP_MSG.textSelectionCommand, op: 'dragEnd' },
    ]);
  });
});
