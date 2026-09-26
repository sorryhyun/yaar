/**
 * The phone's own text selection: which word a caret lands in, and the one selection the
 * shell holds — published to the highlight registry, and cleared by a shell drag.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  caretAt,
  claimTouch,
  clearTextSelection,
  getTextSelection,
  isTouchClaimed,
  releaseTouch,
  setTextSelection,
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
    expect(getTextSelection()).toEqual({ range, windowId: 'w1' });
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
