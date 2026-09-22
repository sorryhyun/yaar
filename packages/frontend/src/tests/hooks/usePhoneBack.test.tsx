/**
 * A phone's Back button (issue #118). Back used to walk the browser's history, and the desktop
 * is one page — so the first press left YAAR. It now puts away one layer per press, top first,
 * and only a Back on a bare desktop is the user's to leave with.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { render, cleanup, act } from '@testing-library/react';
import { usePhoneBack } from '@/hooks/usePhoneBack';
import { useDismissable } from '@/hooks/useDismissable';
import { useDesktopStore } from '@/store';

const key = (id: string) => `0/${id}`;

function create(id: string) {
  useDesktopStore.getState().applyAction({
    type: 'window.create',
    windowId: id,
    title: id,
    bounds: { x: 0, y: 0, w: 300, h: 200 },
    content: { renderer: 'markdown', data: 'hello' },
  });
}

function Shell({ onDismiss }: { onDismiss?: () => void }) {
  usePhoneBack();
  useDismissable({ onDismiss: () => onDismiss?.(), enabled: !!onDismiss });
  return null;
}

const guarded = () =>
  (window.history.state as { yaarBackGuard?: boolean } | null)?.yaarBackGuard === true;

/** What the browser does on Back: take the guard entry off, then tell the page. */
function pressBack() {
  act(() => {
    window.history.replaceState(null, '');
    window.dispatchEvent(new window.PopStateEvent('popstate'));
  });
}

const s = () => useDesktopStore.getState();

describe('usePhoneBack', () => {
  beforeEach(() => {
    window.history.replaceState(null, '');
    useDesktopStore.setState({
      windows: {},
      zOrder: [],
      focusedWindowId: null,
      activeMonitorId: '0',
      formFactor: 'mobile',
      fullscreenWindowId: null,
      paletteSheetOpen: false,
      notificationShadeOpen: false,
      cliMode: false,
      toasts: {},
    });
  });
  afterEach(() => cleanup());

  it('puts a guard entry on the history on a phone, and none on a desktop', () => {
    useDesktopStore.setState({ formFactor: 'desktop' });
    render(<Shell />);
    expect(guarded()).toBe(false);
    cleanup();

    useDesktopStore.setState({ formFactor: 'mobile' });
    render(<Shell />);
    expect(guarded()).toBe(true);
  });

  it('closes the surface on the Escape stack first, and re-arms for the next press', () => {
    const dismiss = mock(() => {});
    useDesktopStore.setState({ paletteSheetOpen: true });
    render(<Shell onDismiss={dismiss} />);
    pressBack();
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(s().paletteSheetOpen).toBe(true);
    expect(guarded()).toBe(true);
  });

  it('then puts away the sheet, full screen, CLI and each card, one per press', () => {
    create('a');
    create('b');
    s().toggleFullscreenWindow(key('b'));
    useDesktopStore.setState({ paletteSheetOpen: true, cliMode: true });
    render(<Shell />);

    pressBack();
    expect(s().paletteSheetOpen).toBe(false);
    expect(s().fullscreenWindowId).toBe(key('b'));
    pressBack();
    expect(s().fullscreenWindowId).toBeNull();
    expect(s().cliMode).toBe(true);
    pressBack();
    expect(s().cliMode).toBe(false);
    pressBack();
    // Minimized, never closed — closing would retire an app agent.
    expect(s().windows[key('b')]?.minimized).toBe(true);
    expect(s().windows[key('a')]?.minimized).toBe(false);
    pressBack();
    expect(s().windows[key('a')]?.minimized).toBe(true);
    expect(guarded()).toBe(true);
  });

  it('on a bare desktop, hints instead and leaves the guard off so the next Back leaves', () => {
    render(<Shell />);
    pressBack();
    expect(guarded()).toBe(false);
    expect(Object.keys(s().toasts)).toContain('phone-back-exit');
  });

  it('ignores a popstate that lands on a guard (a Forward, not a Back)', () => {
    create('a');
    render(<Shell />);
    act(() => {
      window.dispatchEvent(new window.PopStateEvent('popstate'));
    });
    expect(s().windows[key('a')]?.minimized).toBe(false);
  });
});
