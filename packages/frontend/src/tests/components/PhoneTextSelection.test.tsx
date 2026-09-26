/**
 * The phone's long-press selection, driven by touches: what a held finger selects, what
 * a moving one does not, what a tap clears, and what the menu does with the word.
 *
 * happy-dom has no hit testing, so `caretRangeFromPoint` is stubbed to put the caret at a
 * fixed offset of the content's text — the word logic itself is `textSelection.test.ts`'s.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
import { render, cleanup, act, fireEvent, screen } from '@testing-library/react';
import { useDesktopStore } from '@/store';
import { LONG_PRESS_MS, PhoneTextSelection } from '@/components/desktop/PhoneTextSelection';
import { getTextSelection, clearTextSelection, isTouchClaimed } from '@/lib/textSelection';
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
    // The caret always lands inside "press".
    doc.caretRangeFromPoint = () => {
      const r = document.createRange();
      r.setStart(paragraph.firstChild!, 7);
      return r;
    };
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
    expect(getTextSelection()?.range.toString()).toBe('press');
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
    expect(getTextSelection()?.range.toString()).toBe('long press here');
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
});
