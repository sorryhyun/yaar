import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { useDesktopStore } from '@/store';

// Mock useAgentConnection — must be before importing CommandPalette
mock.module('@/hooks/useAgentConnection', () => ({
  useAgentConnection: () => ({
    isConnected: true,
    sendMessage: mock(() => {}),
    interrupt: mock(() => {}),
    reset: mock(() => {}),
  }),
}));

const { CommandPalette } = await import('@/components/command-palette/CommandPalette');

describe('CommandPalette', () => {
  beforeEach(() => {
    useDesktopStore.setState({
      activeAgents: {},
      hasDrawing: false,
      windows: {},
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the reset button', () => {
    render(<CommandPalette />);
    expect(screen.getByTitle('Reset windows and context')).toBeInTheDocument();
  });

  it('renders the input field', () => {
    render(<CommandPalette />);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });
});

/**
 * The phone bottom sheet, which is a keyboard request as much as it is a panel: the
 * whole point of the pull-up is to get at the input, so anything that makes the keyboard
 * arrive a beat later undoes most of the gesture.
 */
describe('CommandPalette bottom sheet', () => {
  beforeEach(() => {
    useDesktopStore.setState({
      formFactor: 'mobile',
      paletteSheetOpen: false,
      notificationShadeOpen: false,
      activeAgents: {},
      hasDrawing: false,
      windows: {},
    });
  });

  afterEach(() => {
    cleanup();
    useDesktopStore.setState({ formFactor: 'desktop', paletteSheetOpen: false });
  });

  /** happy-dom has no TouchEvent; the handlers only read the two touch lists. */
  function touch(target: EventTarget, type: string, x: number, y: number) {
    const DomEvent = document.defaultView!.Event;
    const event = new DomEvent(type, { bubbles: true, cancelable: true });
    const list = [{ clientX: x, clientY: y, identifier: 0 }];
    Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : list });
    Object.defineProperty(event, 'changedTouches', { value: list });
    act(() => {
      target.dispatchEvent(event);
    });
  }

  const handle = () => screen.getByLabelText('Open the input field');

  // Both rows moved into the pull-down shade: two strips of chips stacked on a sheet
  // that is collapsed most of the time were spending a small screen on chrome that is
  // only wanted between one thing and the next.
  it('leaves the monitor and window rows to the shade', () => {
    useDesktopStore.setState({
      paletteSheetOpen: true,
      windows: {
        w1: {
          id: 'w1',
          title: 'Notes',
          monitorId: '0',
          bounds: { x: 0, y: 0, w: 400, h: 300 },
          content: { renderer: 'markdown', data: '' },
          minimized: false,
          maximized: false,
        },
      } as never,
      activeMonitorId: '0',
    });
    render(<CommandPalette />);
    expect(screen.queryByTitle('Create new monitor')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Notes')).not.toBeInTheDocument();
  });

  it('raises the sheet while the finger is still pulling', () => {
    render(<CommandPalette />);
    touch(handle(), 'touchstart', 200, 600);
    touch(handle(), 'touchmove', 200, 520);
    // Not waiting for touchend is most of the wait: the sheet's slide and the rest of
    // the drag overlap instead of queueing.
    expect(useDesktopStore.getState().paletteSheetOpen).toBe(true);
  });

  it('asks for the keyboard from inside the gesture, not from an effect afterwards', () => {
    render(<CommandPalette />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

    // A phone opens its keyboard only for a focus() that a user gesture is still
    // activating. There is no way to observe that policy here, but there is a way to
    // observe the ordering it needs: the handler focuses *before* it reports the sheet
    // open, so a focus that sees `paletteSheetOpen` already true came from the effect.
    const sheetWasOpen: boolean[] = [];
    const realFocus = textarea.focus.bind(textarea);
    textarea.focus = ((options?: FocusOptions) => {
      sheetWasOpen.push(useDesktopStore.getState().paletteSheetOpen);
      realFocus(options);
    }) as typeof textarea.focus;

    touch(handle(), 'touchstart', 200, 600);
    touch(handle(), 'touchend', 200, 520);

    expect(sheetWasOpen[0]).toBe(false);
    expect(document.activeElement).toBe(textarea);
  });

  it('a tap does the same thing as a pull', () => {
    render(<CommandPalette />);
    fireEvent.click(handle());
    expect(useDesktopStore.getState().paletteSheetOpen).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('textbox'));
  });

  it('pulling back down puts it away and takes the keyboard with it', () => {
    useDesktopStore.setState({ paletteSheetOpen: true });
    render(<CommandPalette />);
    const open = screen.getByLabelText('Close the input field');
    touch(open, 'touchstart', 200, 500);
    touch(open, 'touchend', 200, 600);
    expect(useDesktopStore.getState().paletteSheetOpen).toBe(false);
    expect(document.activeElement).not.toBe(screen.getByRole('textbox'));
  });
});
