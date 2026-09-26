/**
 * The phone's long-press selection, driven by touches: what a held finger selects, what
 * a moving one does not, what a tap clears, and what the menu does with the word.
 *
 * happy-dom has no hit testing, so `caretRangeFromPoint` is stubbed to put the caret where
 * the test says — the word and range logic itself is `textSelection.test.ts`'s — and no
 * layout, so the content box is given one for the handles to be drawn inside.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
import { render, cleanup, act, fireEvent, screen } from '@testing-library/react';
import { useDesktopStore } from '@/store';
import { LONG_PRESS_MS, PhoneTextSelection } from '@/components/desktop/PhoneTextSelection';
import {
  getTextSelection,
  clearTextSelection,
  isTouchClaimed,
  selectionText,
} from '@/lib/textSelection';
import { APP_MSG } from '@yaar/shared';
import { WINDOW_ID_DATA_ATTR } from '@/constants/layout';

/** See `PhoneGestures.test.tsx`: a plain Event carrying the touch lists is enough. */
function touch(target: EventTarget, type: string, x: number, y: number): Event {
  const DomEvent = document.defaultView!.Event;
  const event = new DomEvent(type, { bubbles: true, cancelable: true });
  const list = [{ clientX: x, clientY: y, identifier: 0 }];
  Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : list });
  Object.defineProperty(event, 'changedTouches', { value: list });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

/** happy-dom has no `DOMRect` global; a plain box reads the same. */
function box(left: number, top: number, width: number, height: number): DOMRect {
  const r = {
    left,
    top,
    width,
    height,
    x: left,
    y: top,
    right: left + width,
    bottom: top + height,
  };
  return { ...r, toJSON: () => r } as DOMRect;
}

function selectedText(): string | undefined {
  const selection = getTextSelection();
  return selection ? selectionText(selection) : undefined;
}

function hold() {
  act(() => {
    jest.advanceTimersByTime(LONG_PRESS_MS + 10);
  });
}

describe('PhoneTextSelection', () => {
  const doc = document as unknown as { caretRangeFromPoint?: unknown };
  let frame: HTMLElement;
  let content: HTMLElement;
  let paragraph: HTMLElement;
  let caretOffset = 7;

  beforeEach(() => {
    useDesktopStore.setState({
      formFactor: 'mobile',
      toasts: {},
      windows: {
        w1: { id: 'w1', title: 'Notes' } as never,
      },
    });
    frame = document.createElement('div');
    frame.setAttribute(WINDOW_ID_DATA_ATTR, 'w1');
    content = document.createElement('div');
    content.setAttribute('data-window-content', '');
    paragraph = document.createElement('p');
    paragraph.textContent = 'long press here';
    content.appendChild(paragraph);
    frame.appendChild(content);
    document.body.appendChild(frame);
    // The caret lands inside "press" unless a test moves it.
    caretOffset = 7;
    doc.caretRangeFromPoint = () => {
      const r = document.createRange();
      r.setStart(paragraph.firstChild!, caretOffset);
      return r;
    };
    content.getBoundingClientRect = () => box(-10, -10, 400, 800);
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    cleanup();
    clearTextSelection();
    frame.remove();
    delete doc.caretRangeFromPoint;
  });

  it('selects the word under a finger held still, and claims the touch', () => {
    render(<PhoneTextSelection />);
    touch(paragraph, 'touchstart', 50, 50);
    hold();
    expect(selectedText()).toBe('press');
    expect(getTextSelection()?.windowId).toBe('w1');
    expect(isTouchClaimed()).toBe(true);
    expect(screen.getByRole('menu')).toBeTruthy();

    // The lift after a long-press must not become a click on the word.
    const end = touch(paragraph, 'touchend', 50, 50);
    expect(end.defaultPrevented).toBe(true);
    expect(getTextSelection()).not.toBeNull();
  });

  it('leaves a finger that moved to the scroll it started', () => {
    render(<PhoneTextSelection />);
    touch(paragraph, 'touchstart', 50, 50);
    touch(paragraph, 'touchmove', 50, 70);
    hold();
    expect(getTextSelection()).toBeNull();
    expect(isTouchClaimed()).toBe(false);
  });

  it('does not select from a control or a field', () => {
    const button = document.createElement('button');
    button.textContent = 'press';
    content.appendChild(button);
    render(<PhoneTextSelection />);
    touch(button, 'touchstart', 50, 50);
    hold();
    expect(getTextSelection()).toBeNull();
  });

  it('clears on a tap elsewhere, but not on a tap in its own menu', () => {
    render(<PhoneTextSelection />);
    touch(paragraph, 'touchstart', 50, 50);
    hold();
    touch(paragraph, 'touchend', 50, 50);

    const menu = screen.getByRole('menu');
    touch(menu, 'touchstart', 10, 10);
    touch(menu, 'touchend', 10, 10);
    expect(getTextSelection()).not.toBeNull();

    touch(document.body, 'touchstart', 200, 200);
    touch(document.body, 'touchend', 200, 200);
    expect(getTextSelection()).toBeNull();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('keeps the selection through a scroll', () => {
    render(<PhoneTextSelection />);
    touch(paragraph, 'touchstart', 50, 50);
    hold();
    touch(paragraph, 'touchend', 50, 50);

    touch(document.body, 'touchstart', 200, 200);
    touch(document.body, 'touchmove', 200, 120);
    touch(document.body, 'touchend', 200, 120);
    expect(getTextSelection()).not.toBeNull();
  });

  it('selects all of the window with Select all', () => {
    render(<PhoneTextSelection />);
    touch(paragraph, 'touchstart', 50, 50);
    hold();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Select all' }));
    expect(selectedText()).toBe('long press here');
  });

  it('hands the word to the Ask AI input', () => {
    render(<PhoneTextSelection />);
    touch(paragraph, 'touchstart', 50, 50);
    hold();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Ask AI' }));
    expect(screen.queryByRole('menu')).toBeNull();
    const input = screen.getByPlaceholderText('What to do with selection...');

    const queued: string[] = [];
    useDesktopStore.setState({ queueGestureMessage: (m: string) => void queued.push(m) });
    (input as HTMLInputElement).value = 'translate';
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(queued[0]).toContain('selected_text: "press"');
    expect(queued[0]).toContain('window "Notes" (id: w1)');
    expect(getTextSelection()).toBeNull();
  });

  it('copies the word and says so', async () => {
    const written: string[] = [];
    const g = globalThis as unknown as { isSecureContext?: boolean };
    const secure = g.isSecureContext;
    g.isSecureContext = true;
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async (t: string) => void written.push(t) },
      configurable: true,
    });
    render(<PhoneTextSelection />);
    touch(paragraph, 'touchstart', 50, 50);
    hold();
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Copy' }));
    });
    expect(written).toEqual(['press']);
    expect(Object.values(useDesktopStore.getState().toasts).map((t) => t.message)).toEqual([
      'Copied',
    ]);
    expect(getTextSelection()).toBeNull();
    g.isSecureContext = secure;
  });

  it('stays out of a desktop entirely', () => {
    useDesktopStore.setState({ formFactor: 'desktop' });
    render(<PhoneTextSelection />);
    touch(paragraph, 'touchstart', 50, 50);
    hold();
    expect(getTextSelection()).toBeNull();
  });

  it('drags an end with its handle, past the other one too, without the menu in the way', () => {
    render(<PhoneTextSelection />);
    touch(paragraph, 'touchstart', 50, 50);
    hold();
    touch(paragraph, 'touchend', 50, 50);

    const endHandle = document.querySelector('[data-text-selection-handle="end"]')!;
    expect(document.querySelector('[data-text-selection-handle="start"]')).not.toBeNull();
    touch(endHandle, 'touchstart', 60, 70);
    // Claimed on the spot, so the shell's gestures never take it.
    expect(isTouchClaimed()).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();

    caretOffset = 15;
    const move = touch(endHandle, 'touchmove', 120, 70);
    expect(move.defaultPrevented).toBe(true);
    expect(selectedText()).toBe('press here');

    // Past the start: the start becomes the end, and "press" is the anchor it turns on.
    caretOffset = 0;
    touch(endHandle, 'touchmove', 0, 70);
    expect(selectedText()).toBe('long ');

    touch(endHandle, 'touchend', 0, 70);
    expect(selectedText()).toBe('long ');
    expect(screen.getByRole('menu')).toBeTruthy();
  });

  it('clears when a pan or a pull takes the desktop out from under it', async () => {
    render(<PhoneTextSelection />);
    touch(paragraph, 'touchstart', 50, 50);
    hold();
    touch(paragraph, 'touchend', 50, 50);
    document.documentElement.dataset.shadePull = 'dragging';
    // MutationObserver callbacks are microtasks.
    await act(async () => {});
    expect(getTextSelection()).toBeNull();
    delete document.documentElement.dataset.shadePull;
  });

  describe('in an app frame', () => {
    let card: HTMLElement;
    let iframe: HTMLIFrameElement;
    const posted: unknown[] = [];

    beforeEach(() => {
      posted.length = 0;
      card = document.createElement('div');
      card.setAttribute(WINDOW_ID_DATA_ATTR, 'w1');
      iframe = document.createElement('iframe');
      card.appendChild(iframe);
      document.body.appendChild(card);
      iframe.getBoundingClientRect = () => box(0, 0, 400, 800);
      (iframe.contentWindow as unknown as { postMessage: unknown }).postMessage = (m: unknown) =>
        posted.push(m);
    });

    afterEach(() => card.remove());

    /** See PhoneGestures.test.tsx: happy-dom's postMessage loses `source` identity. */
    function fromFrame(data: unknown) {
      act(() => {
        const ev = new document.defaultView!.Event('message');
        Object.defineProperty(ev, 'data', { value: data });
        Object.defineProperty(ev, 'source', { value: iframe.contentWindow });
        window.dispatchEvent(ev);
      });
    }

    const report = {
      type: APP_MSG.textSelection,
      selection: {
        text: 'framed',
        start: { x: 10, top: 20, bottom: 40 },
        end: { x: 60, top: 20, bottom: 40 },
        bounds: { left: 10, top: 20, width: 50, height: 20 },
      },
    };

    it("draws the frame's selection with the same handles and menu", () => {
      render(<PhoneTextSelection />);
      fromFrame(report);
      expect(selectedText()).toBe('framed');
      expect(screen.getByRole('menu')).toBeTruthy();
      expect(document.querySelectorAll('[data-text-selection-handle]').length).toBe(2);

      fromFrame({ type: APP_MSG.textSelection, selection: null });
      expect(getTextSelection()).toBeNull();
      expect(posted).toEqual([]);
    });

    it('ignores a report too malformed to place', () => {
      render(<PhoneTextSelection />);
      fromFrame({ type: APP_MSG.textSelection, selection: { text: 'x', start: 'nope' } });
      expect(getTextSelection()).toBeNull();
    });

    it('tells the frame to let go on a tap outside it', () => {
      render(<PhoneTextSelection />);
      fromFrame(report);
      touch(document.body, 'touchstart', 200, 200);
      touch(document.body, 'touchend', 200, 200);
      expect(getTextSelection()).toBeNull();
      expect(posted).toEqual([{ type: APP_MSG.textSelectionCommand, op: 'clear' }]);
    });

    it("clears the shell's own selection on a tap inside a frame", () => {
      render(<PhoneTextSelection />);
      touch(paragraph, 'touchstart', 50, 50);
      hold();
      touch(paragraph, 'touchend', 50, 50);
      fromFrame({ type: APP_MSG.click });
      expect(getTextSelection()).toBeNull();
    });
  });
});
