/**
 * The frame half of the phone's text selection (`@yaar/shared`'s
 * `iframe-scripts/text-selection.ts`), run the way a frame runs it: evaluated over a stub
 * `window` whose parent collects what is posted.
 *
 * Here rather than beside the script because it needs a DOM — ranges, a tree walker, text
 * nodes to hit — and `@yaar/shared`'s tests run without one. As in the desktop's tests,
 * happy-dom has no hit testing, so the caret lands where the test puts it.
 *
 * The document is the test's global one: a second document's ranges read back empty in
 * happy-dom. Each case installs a fresh copy (the install guard is on the stub window),
 * so earlier copies are still listening; each posts into its own sink, which keeps them
 * out of the case's assertions.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
import { APP_MSG, IFRAME_TEXT_SELECTION_SCRIPT } from '@yaar/shared';

type Listener = (e: unknown) => void;

interface Report {
  type: string;
  selection: { text?: string } | null;
}

describe('text-selection frame script', () => {
  const doc = document;
  let root: HTMLElement;
  let paragraph: HTMLElement;
  let posted: Report[];
  let win: Record<string, unknown> & { parent: object };
  let winListeners: Map<string, Listener[]>;
  let caret: { node: Node; offset: number };

  function install() {
    new Function('window', 'document', IFRAME_TEXT_SELECTION_SCRIPT)(win, doc);
  }

  function touch(target: EventTarget, type: string, x: number, y: number): Event {
    const event = new document.defaultView!.Event(type, { bubbles: true, cancelable: true });
    const list = [{ clientX: x, clientY: y, identifier: 0 }];
    Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : list });
    Object.defineProperty(event, 'changedTouches', { value: list });
    target.dispatchEvent(event);
    return event;
  }

  function command(data: Record<string, unknown>, source: unknown = win.parent) {
    for (const fn of winListeners.get('message') ?? []) {
      fn({ data: { type: APP_MSG.textSelectionCommand, ...data }, source });
    }
  }

  const last = () => posted[posted.length - 1];

  function longPress() {
    touch(paragraph, 'touchstart', 50, 50);
    jest.advanceTimersByTime(410);
  }

  beforeEach(() => {
    doc.documentElement.setAttribute('data-form-factor', 'mobile');
    root = doc.createElement('main');
    root.innerHTML = '<p>long press here</p><p>second line</p><button>press</button>';
    doc.body.appendChild(root);
    paragraph = root.querySelector('p')!;
    caret = { node: paragraph.firstChild!, offset: 7 };
    (doc as unknown as { caretRangeFromPoint: unknown }).caretRangeFromPoint = () => {
      const r = doc.createRange();
      r.setStart(caret.node, caret.offset);
      return r;
    };
    const sink: Report[] = [];
    posted = sink;
    winListeners = new Map();
    win = {
      parent: { postMessage: (m: Report) => sink.push(m) },
      innerWidth: 400,
      innerHeight: 800,
      addEventListener(type: string, fn: Listener) {
        winListeners.set(type, [...(winListeners.get(type) ?? []), fn]);
      },
    };
    jest.useFakeTimers();
    install();
  });

  afterEach(() => {
    jest.useRealTimers();
    root.remove();
    doc.documentElement.removeAttribute('data-form-factor');
    delete (doc as unknown as { caretRangeFromPoint?: unknown }).caretRangeFromPoint;
  });

  it('makes app content unselectable on a phone, fields excepted', () => {
    const styles = doc.head.querySelectorAll('style');
    const css = styles[styles.length - 1].textContent!;
    expect(css).toContain('html[data-form-factor="mobile"] *');
    expect(css).toContain('user-select:none !important');
    expect(css).toMatch(/:is\(input, textarea,[^{]*\{[^}]*user-select:text !important/);
    expect(css).toContain('::highlight(yaar-selection)');
  });

  it('selects the word under a held finger, reports it, and claims the touch', () => {
    longPress();
    expect(last()).toMatchObject({
      type: APP_MSG.textSelection,
      selection: { text: 'press' },
    });
    expect(win.__yaarTouchClaimed).toBe(true);
    // The lift must not become a click on the word.
    expect(touch(paragraph, 'touchend', 50, 50).defaultPrevented).toBe(true);
  });

  it('leaves a moving finger, a control, and a desktop alone', () => {
    touch(paragraph, 'touchstart', 50, 50);
    touch(paragraph, 'touchmove', 50, 70);
    jest.advanceTimersByTime(410);

    touch(root.querySelector('button')!, 'touchstart', 50, 50);
    jest.advanceTimersByTime(410);

    doc.documentElement.setAttribute('data-form-factor', 'desktop');
    longPress();
    expect(posted).toEqual([]);
    expect(win.__yaarTouchClaimed).toBe(false);
  });

  it('clears on a tap, and says so', () => {
    longPress();
    touch(paragraph, 'touchend', 50, 50);
    touch(paragraph, 'touchstart', 50, 50);
    touch(paragraph, 'touchend', 50, 50);
    expect(last()).toEqual({ type: APP_MSG.textSelection, selection: null });
  });

  it('takes commands from its parent only', () => {
    longPress();
    posted.length = 0;
    command({ op: 'selectAll' }, {});
    expect(posted).toEqual([]);
    command({ op: 'selectAll' });
    // To the last text that is not a control's: a handle on a button is one nobody can grab.
    expect(last().selection?.text).toBe('long press heresecond line');
  });

  it('is cleared by the desktop without reporting back', () => {
    longPress();
    posted.length = 0;
    command({ op: 'clear' });
    // A tap now has nothing to clear, so nothing is reported either.
    touch(paragraph, 'touchstart', 50, 50);
    touch(paragraph, 'touchend', 50, 50);
    expect(posted).toEqual([]);
  });

  it('moves the dragged end to where the handle is, across paragraphs', () => {
    longPress();
    command({ op: 'dragStart', end: 'end' });
    caret = { node: root.querySelectorAll('p')[1].firstChild!, offset: 6 };
    command({ op: 'drag', x: 100, y: 100 });
    expect(last().selection?.text).toBe('press heresecond');

    // Dragged past the start, it turns on the start of "press".
    caret = { node: paragraph.firstChild!, offset: 0 };
    command({ op: 'drag', x: 10, y: 10 });
    expect(last().selection?.text).toBe('long ');
    command({ op: 'dragEnd' });
  });
});
